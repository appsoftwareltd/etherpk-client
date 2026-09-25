/**
 * Encrypted asset store for a Server-backed graph (ADR 0027). Assets are chunked and each
 * chunk AEAD-encrypted under a random per-asset key; that key (plus filename, MIME, and the
 * plaintext content hash for within-graph dedup) travels inside metadata encrypted under the
 * graph epoch key. The server stores only ciphertext + presigns S3 access — bytes go
 * client ↔ S3 directly, never through the app process, and object keys use a RANDOM asset id
 * so the layout leaks nothing.
 *
 * Implements the same AssetStore surface as the Filesystem store; framework-free, fetch injected.
 */
import {
    type GraphKeyring,
    assetDedupToken,
    contextAad,
    currentEpoch,
    deriveAssetDedupSecret,
    fromBase64Url,
    keyForEpoch,
    openSymmetric,
    randomBytes,
    sealSymmetric,
    toBase64Url,
    utf8,
} from '$lib/crypto'
import { withRetry, type RetryOptions } from '$lib/retry'
import {
    ASSET_CHUNK_PLAINTEXT_BYTES,
    assetChunkCount,
    quotaErrorResponseSchema,
    type QuotaErrorCode,
} from '@appsoftwareltd/etherpk-shared'
import type { AssetBytes, AssetStore, ResolvedAsset, SavedAsset } from '$lib/storage/fs/asset-store'
import type { SyncTokenSource } from '$lib/sync/sync-token'

/**
 * ADR 0027 specifies fixed chunks "of order 1-4 MiB", one AEAD envelope each: the envelope is
 * the unit of decryption, so it bounds resumable and ranged transfer. 4 MiB is the top of that
 * band - a quarter of the objects, presigned URLs and R2 write operations of 1 MiB, while a
 * retry after a blip still re-sends only 4 MiB. Read-side reassembly derives lengths from the
 * chunks themselves, so raising this does not disturb assets already stored at 1 MiB.
 */
// Shared with the Sync Server, which derives the chunk count and each chunk's exact signed
// Content-Length from the same constant. The two must not drift.
const CHUNK_SIZE = ASSET_CHUNK_PLAINTEXT_BYTES
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])

/**
 * The server declined this asset on policy, not on luck: the response carried a
 * `quota_denied` code. Retrying changes nothing, so the caller decides between skipping the
 * asset and abandoning the run, which is a different question per code - a file over the
 * per-asset limit is one asset's problem, an exhausted account is every asset's problem.
 */
export class AssetRefusedError extends Error {
    readonly name = 'AssetRefusedError'

    constructor(readonly code: QuotaErrorCode, message: string = refusalMessage(code)) {
        super(message)
    }

    /** True when only THIS asset is refused; anything else condemns the rest of the run too. */
    get isPerAsset(): boolean {
        return this.code === 'asset_size_limit' || this.code === 'asset_chunk_limit'
    }
}

/**
 * Turn a refused begin into the most specific error available. A quota refusal names the policy
 * that declined it, so the import can say "over your plan's per-file limit" rather than "403",
 * and can tell a single oversized file apart from an account with no room left.
 */
async function beginFailure(res: Response): Promise<Error> {
    if (res.status === 403) {
        const parsed = quotaErrorResponseSchema.safeParse(await res.json().catch(() => null))
        if (parsed.success) return new AssetRefusedError(parsed.data.code)
    }
    return new HttpFailure(res.status, `asset begin failed: ${res.status}`)
}

function refusalMessage(code: QuotaErrorCode): string {
    switch (code) {
        case 'asset_size_limit':
            return "it is larger than your plan's limit for a single file"
        case 'asset_chunk_limit':
            return "it needs more parts than your plan allows for a single file"
        case 'owned_storage_limit':
            return 'your account has no storage left'
        case 'entitlement_inactive':
            return 'your plan is not active for new uploads'
        default:
            return `your plan refused it (${code})`
    }
}

/** An HTTP response the upload could not use; carries the status so retry can judge it. */
class HttpFailure extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

/**
 * Worth another attempt? Anything that never reached a status (a dropped connection, and
 * also a CORS refusal - indistinguishable in the browser, so it costs a few seconds before
 * the same named error) plus the statuses that mean "not your fault, try again". A 401 is
 * retryable BECAUSE the retry presents a freshly minted token; the arm below forces one.
 */
function isTransient(error: unknown): boolean {
    if (!(error instanceof HttpFailure)) return true
    return error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500
}

interface AssetMetadata {
    name: string
    type: string
    hash: string
    isImage: boolean
    /** The per-asset AEAD key (base64url) — wrapped by living inside the epoch-encrypted blob. */
    perAssetKey: string
}

export interface ServerAssetStoreDeps {
    graphId: string
    keyring: GraphKeyring
    baseUrl: string
    /**
     * Supplies a sync token (member of the graph) per request, presented as x-sync-token.
     * A source rather than a string because an import outlives a token's 15 minutes -
     * holding one made every upload past that mark 401 (see `sync-token.ts`).
     */
    syncToken: SyncTokenSource
    fetch?: typeof fetch
    /** Injectable for tests: create a random asset id. */
    newAssetId?: () => string
    /** Cancels an in-progress upload, including any backoff it is waiting out. */
    signal?: AbortSignal
    /** Test seam: shrink the backoff so retry specs do not sit through real waits. */
    retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'sleep' | 'random' | 'onRetry'>
}

function kebabStem(name: string): string {
    const stem = name.replace(/\.[^.]+$/, '')
    return stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
}
function extOf(name: string): string {
    const m = /\.([^.]+)$/.exec(name)
    return m ? m[1].toLowerCase() : 'bin'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parse the random asset id out of a server asset ref. The id is the [[Asset]]'s identity on this
 * backend — the stem is whatever name THIS reference was pasted with — so this is also what a
 * delete and a usage count are keyed on (ADR 0054).
 *
 * Two shapes, because two things address an asset. A document writes `<stem>.<uuid>.<ext>`. The
 * asset [[View]] addresses it by identity alone, `<uuid>` or `<uuid>.<ext>`, since a tab is keyed
 * on the Asset rather than on whichever reference opened it — and that has to resolve too.
 */
export function assetIdFromRef(ref: string): string | null {
    const file = ref.split('/').pop() ?? ref
    const m = /(?:^|\.)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[^.]+)?$/.exec(file)
    return m ? m[1] : null
}

export function createServerAssetStore(deps: ServerAssetStoreDeps): AssetStore {
    const f = deps.fetch ?? fetch
    const base = deps.baseUrl.replace(/\/$/, '')
    const newAssetId = deps.newAssetId ?? (() => crypto.randomUUID())
    const objectUrls: string[] = []
    // The per-graph dedup secret (ADR 0053) never changes for a keyring, so derive it once,
    // lazily - a store that only ever resolves never pays for it.
    let dedupSecretPromise: Promise<Uint8Array> | undefined
    const dedupSecret = () => (dedupSecretPromise ??= deriveAssetDedupSecret(deps.keyring))

    const authHeaders = async (fresh = false) => ({
        'x-sync-token': await deps.syncToken(fresh ? { force: true } : undefined),
        'Content-Type': 'application/json',
    })

    const retryOptions: RetryOptions = { ...deps.retry, signal: deps.signal, shouldRetry: isTransient }

    /**
     * One HTTP step of an upload, retried. `fresh` is true on an attempt that follows a 401:
     * the server has retired a token this client still believed was live (the clocks
     * disagree), so the next attempt mints one rather than presenting the same dead token.
     */
    function step<T>(run: (fresh: boolean) => Promise<T>): Promise<T> {
        let tokenRejected = false
        return withRetry(async () => {
            const fresh = tokenRejected
            tokenRejected = false
            try {
                return await run(fresh)
            } catch (err) {
                if (err instanceof HttpFailure && err.status === 401) tokenRejected = true
                throw err
            }
        }, retryOptions)
    }

    /**
     * Fetch, decrypt and reassemble one asset. Both read paths go through here: the mirror
     * wants the bytes themselves, a viewer wants them behind an object URL.
     */
    async function readAssetBytes(ref: string): Promise<AssetBytes | null> {
        const assetId = assetIdFromRef(ref)
        if (!assetId) return null
        const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`, {
            headers: { 'x-sync-token': await deps.syncToken() },
        })
        if (!res.ok) return null
        const body = (await res.json()) as {
            encryptedMetadata: string
            downloadUrls: string[]
        }
        // Decrypt metadata under the epoch key → the per-asset key + MIME.
        const metaPlain = await openSymmetric({
            keyForEpoch: (id) => keyForEpoch(deps.keyring, id),
            envelope: fromBase64Url(body.encryptedMetadata),
            aad: contextAad('asset-meta', `graph:${deps.graphId}`, `id:${assetId}`),
        })
        const metadata = JSON.parse(new TextDecoder().decode(metaPlain.plaintext)) as AssetMetadata
        const perAssetKey = fromBase64Url(metadata.perAssetKey)

        // Download + decrypt each chunk, reassemble.
        const parts: Uint8Array[] = []
        for (let n = 0; n < body.downloadUrls.length; n++) {
            const chunkRes = await f(body.downloadUrls[n])
            if (!chunkRes.ok) return null
            const encrypted = new Uint8Array(await chunkRes.arrayBuffer())
            const { plaintext } = await openSymmetric({
                keyForEpoch: () => perAssetKey,
                envelope: encrypted,
                aad: contextAad('asset', `id:${assetId}`, `chunk:${n}`),
            })
            parts.push(plaintext)
        }
        const total = parts.reduce((n, p) => n + p.length, 0)
        const joined = new Uint8Array(total)
        let offset = 0
        for (const p of parts) {
            joined.set(p, offset)
            offset += p.length
        }
        // The metadata carries the name the uploader actually chose, casing and spaces intact
        // ("Q3 Report.pdf"), which the kebab-cased ref cannot. That is what a download is
        // called and what titles an asset tab.
        return { bytes: joined, name: metadata.name, type: metadata.type }
    }

    return {
        async save({ name, bytes, type }, onBytes): Promise<SavedAsset> {
            const assetId = newAssetId()
            const perAssetKey = randomBytes(32)
            const hash = await sha256Hex(bytes)
            const stem = kebabStem(name)
            const ext = extOf(name)
            const isImage = IMAGE_EXT.has(ext)
            const chunkCount = assetChunkCount(bytes.length)
            // The ref carries THIS file's stem and extension around whichever id the bytes end
            // up under; resolution reads only the id (`assetIdFromRef`), so a reused asset can
            // wear the name it was pasted with.
            const saved = (id: string, reused: boolean): SavedAsset => ({
                ref: `../assets/${stem}.${id}.${ext}`,
                name: `${stem}.${id}.${ext}`,
                stem,
                isImage,
                ...(reused ? { reused } : {}),
            })

            // Within-graph reuse (ADR 0053): a blinded token of the content hash travels with
            // the begin call. The server can index it but not invert it, so it answers "these
            // bytes are already here" without learning what they are.
            const dedupToken = await assetDedupToken(await dedupSecret(), hash)

            // Metadata encrypted under the CURRENT graph epoch key.
            const metadata: AssetMetadata = { name, type, hash, isImage, perAssetKey: toBase64Url(perAssetKey) }
            const encryptedMetadata = await sealSymmetric({
                key: currentEpoch(deps.keyring).key,
                epochId: currentEpoch(deps.keyring).epochId,
                plaintext: utf8(JSON.stringify(metadata)),
                aad: contextAad('asset-meta', `graph:${deps.graphId}`, `id:${assetId}`),
            })

            // Begin: record metadata + get one presigned PUT URL per chunk, OR learn that a
            // complete asset in this graph already carries the token. Safe to retry - the
            // server records (graph, asset) ON CONFLICT DO NOTHING, so a second attempt
            // stores nothing new, double-counts no storage, and simply re-presigns.
            const begun = await step(async (fresh) => {
                const res = await f(`${base}/api/v1/sync/assets`, {
                    method: 'POST',
                    headers: await authHeaders(fresh),
                    body: JSON.stringify({
                        graphId: deps.graphId,
                        assetId,
                        size: bytes.length,
                        chunkCount,
                        encryptedMetadata: toBase64Url(encryptedMetadata),
                        dedupToken,
                    }),
                })
                if (!res.ok) throw await beginFailure(res)
                return (await res.json()) as { uploadUrls: string[] } | { reuse: { assetId: string } }
            })
            if ('reuse' in begun) {
                // Nothing to encrypt or push. Report the bytes as retired all the same: the
                // caller is measuring work done, not bytes through a socket (as the
                // Filesystem store does for its own dedup), so an Activity bar still completes.
                onBytes?.(bytes.length)
                return saved(begun.reuse.assetId, true)
            }
            const { uploadUrls } = begun

            // Chunk + encrypt each chunk under the per-asset key (AAD binds asset id + index).
            // After begin, not before: a reuse answer makes this work unnecessary, and for a
            // large video that is the difference between instant and a long wait.
            const chunks: Uint8Array[] = []
            for (let n = 0; n < chunkCount; n++) {
                const slice = bytes.subarray(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE)
                chunks.push(
                    await sealSymmetric({
                        key: perAssetKey,
                        epochId: 0,
                        plaintext: slice,
                        aad: contextAad('asset', `id:${assetId}`, `chunk:${n}`),
                    }),
                )
            }

            // Upload each encrypted chunk straight to S3 via its presigned URL. Already
            // parallel: a single large asset is not the serial part - the outer
            // asset-to-asset loop is. Each chunk retries on its own: one blip must not cost
            // the whole asset, let alone (via the import's unwind) the whole graph.
            await Promise.all(
                uploadUrls.map((u, n) =>
                    step(async () => {
                        let r: Response
                        try {
                            r = await f(u, { method: 'PUT', body: chunks[n] as BodyInit })
                        } catch {
                            // A presigned PUT that dies before any HTTP status (the browser's bare
                            // "Failed to fetch") is the bucket refusing the cross-origin request:
                            // the bucket's CORS policy must allow this app origin (see the Synced
                            // Graphs user doc). Name that, or the failure costs hours to diagnose.
                            // Indistinguishable from a dropped connection, so it retries first.
                            throw new Error(
                                'Uploading to the storage bucket was blocked. The bucket\'s CORS policy must allow this app\'s origin - see "Asset storage" in the Synced Graphs doc.',
                            )
                        }
                        if (!r.ok) throw new HttpFailure(r.status, `chunk ${n} upload failed: ${r.status}`)
                        // Report SOURCE bytes for this chunk, so a 400 MB asset moves the bar
                        // ~400 times rather than once. The last chunk is a partial.
                        onBytes?.(Math.min(CHUNK_SIZE, bytes.length - n * CHUNK_SIZE))
                    }),
                ),
            )

            // Complete: flips the row to 'complete', which is INFORMATIONAL - nothing reads it
            // to serve an asset. Retried, but a persistent failure is swallowed: the chunks and
            // metadata are already durable, and forfeiting a twenty-minute import over a
            // cosmetic flag is precisely the trade this retry exists to prevent. A cancellation
            // still propagates.
            await step(async (fresh) => {
                const res = await f(`${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`, {
                    method: 'POST',
                    headers: await authHeaders(fresh),
                })
                if (!res.ok) throw new HttpFailure(res.status, `asset complete failed: ${res.status}`)
            }).catch((err: unknown) => {
                if (deps.signal?.aborted) throw err
            })

            return saved(assetId, false)
        },

        readBytes: readAssetBytes,

        async resolve(ref: string): Promise<ResolvedAsset | null> {
            const asset = await readAssetBytes(ref)
            if (!asset) return null
            const url = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.type }))
            objectUrls.push(url)
            return { url, name: asset.name, type: asset.type }
        },

        dispose() {
            for (const u of objectUrls) URL.revokeObjectURL(u)
            objectUrls.length = 0
        },
    }
}
