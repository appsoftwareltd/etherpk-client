/**
 * The Sync Server's Version History routes (ADR 0184), for one graph, as the Client and the
 * Headless Client call them: with a sync token for the graph, as the asset routes are called.
 *
 * Every answer is checked against the shared schema before it is used. A failed connection, or a
 * status that means "try again", rejects with {@link VersionApiUnavailableError}; any other
 * refusal with {@link VersionApiError}, carrying the server's code.
 */
import {
    deletedItemsSchema,
    versionEnvelopeSchema,
    versionListSchema,
    versionPolicySchema,
    versionUploadResultSchema,
    type DeletedItems,
    type VersionList,
    type VersionListEntry,
    type VersionPolicy,
    type VersionReason,
    type VersionUploadResult,
} from '@appsoftwareltd/etherpk-shared'
import { fromBase64Url, toBase64Url } from '#lib/crypto/bytes.js'
import type { SyncTokenSource } from '#lib/sync/sync-token.js'

export interface VersionApiDeps {
    graphId: string
    baseUrl: string
    syncToken: SyncTokenSource
    fetch?: typeof fetch
}

/** The server refused: `code` is its error code (`stale_epoch`, `quota_denied`, `owner_only` and so on). */
export class VersionApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string | undefined,
        /** For `quota_denied`: why (`entitlement_inactive`, `owned_storage_limit`). */
        readonly quotaCode?: string,
    ) {
        super(message)
        this.name = 'VersionApiError'
    }
}

/** The server could not be reached, or asked to be tried again later. */
export class VersionApiUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'VersionApiUnavailableError'
    }
}

export type AssetRestoreOutcome = 'restored' | 'live' | 'gone'

export interface VersionApi {
    upload(docId: string, version: { versionId: string; epochId: number; reason: VersionReason; envelope: Uint8Array }): Promise<VersionUploadResult['status']>
    verify(docId: string, versionId: string): Promise<void>
    list(docId: string): Promise<VersionList>
    get(docId: string, versionId: string): Promise<{ entry: Omit<VersionListEntry, 'bytes'>; envelope: Uint8Array }>
    removeDocument(docId: string): Promise<number>
    deleted(): Promise<DeletedItems>
    removeAll(): Promise<{ versions: number; assets: number }>
    policy(): Promise<VersionPolicy>
    restoreAsset(assetId: string): Promise<AssetRestoreOutcome>
    removeAssetForGood(assetId: string): Promise<void>
    /** Whether the server still holds the file, live or deleted. */
    assetExists(assetId: string): Promise<boolean>
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504])

/** The error a refused answer stands for, from its status and its JSON body. */
async function refusalFrom(res: Response): Promise<Error> {
    if (TRANSIENT.has(res.status)) {
        return new VersionApiUnavailableError(`The sync server could not answer just now (HTTP ${res.status}).`)
    }
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } | string; code?: string } | null
    // A quota refusal has the shape the other growth writes use: `{ error: 'quota_denied', code }`.
    if (body?.error === 'quota_denied') {
        return new VersionApiError('The graph owner’s plan does not allow this now.', res.status, 'quota_denied', body.code)
    }
    const error = typeof body?.error === 'object' ? body.error : undefined
    return new VersionApiError(error?.message ?? `The sync server refused (HTTP ${res.status}).`, res.status, error?.code)
}

export function createVersionApi(deps: VersionApiDeps): VersionApi {
    const f = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
    const base = deps.baseUrl.replace(/\/$/, '')
    const graph = `${base}/api/v1/sync/graphs/${deps.graphId}`
    const docVersions = (docId: string) => `${graph}/docs/${docId}/versions`
    const asset = (assetId: string) => `${base}/api/v1/sync/assets/${deps.graphId}/${assetId}`

    async function send(url: string, init: { method?: string; body?: unknown }, fresh: boolean): Promise<Response> {
        const headers: Record<string, string> = { 'x-sync-token': await deps.syncToken(fresh ? { force: true } : undefined) }
        if (init.body !== undefined) headers['Content-Type'] = 'application/json'
        try {
            return await f(url, {
                method: init.method ?? 'GET',
                headers,
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            })
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
            throw new VersionApiUnavailableError('The sync server could not be reached.', { cause })
        }
    }

    /** One request; a 401 is tried once more with a freshly minted token, as the asset routes are. */
    async function call(url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
        let res = await send(url, init, false)
        if (res.status === 401) res = await send(url, init, true)
        if (res.ok) return res.json()
        throw await refusalFrom(res)
    }

    return {
        async upload(docId, version) {
            const answer = await call(docVersions(docId), {
                method: 'POST',
                body: {
                    versionId: version.versionId,
                    epochId: version.epochId,
                    reason: version.reason,
                    envelope: toBase64Url(version.envelope),
                },
            })
            return versionUploadResultSchema.parse(answer).status
        },
        async verify(docId, versionId) {
            await call(`${docVersions(docId)}/${versionId}/verified`, { method: 'POST' })
        },
        async list(docId) {
            return versionListSchema.parse(await call(docVersions(docId)))
        },
        async get(docId, versionId) {
            const { envelope, ...entry } = versionEnvelopeSchema.parse(await call(`${docVersions(docId)}/${versionId}`))
            return { entry, envelope: fromBase64Url(envelope) }
        },
        async removeDocument(docId) {
            const answer = (await call(docVersions(docId), { method: 'DELETE' })) as { removed?: unknown }
            return typeof answer.removed === 'number' ? answer.removed : 0
        },
        async deleted() {
            return deletedItemsSchema.parse(await call(`${graph}/deleted`))
        },
        async removeAll() {
            const answer = (await call(`${graph}/kept`, { method: 'DELETE' })) as { versions?: unknown; assets?: unknown }
            return {
                versions: typeof answer.versions === 'number' ? answer.versions : 0,
                assets: typeof answer.assets === 'number' ? answer.assets : 0,
            }
        },
        async policy() {
            return versionPolicySchema.parse(await call(`${graph}/version-policy`))
        },
        async restoreAsset(assetId) {
            const answer = (await call(`${asset(assetId)}/restore`, { method: 'POST' })) as { outcome?: unknown }
            const outcome = answer.outcome
            return outcome === 'restored' || outcome === 'live' ? outcome : 'gone'
        },
        async assetExists(assetId) {
            try {
                await call(asset(assetId))
                return true
            } catch (error) {
                if (error instanceof VersionApiError && error.status === 404) return false
                throw error
            }
        },
        async removeAssetForGood(assetId) {
            try {
                await call(`${asset(assetId)}?forGood=1`, { method: 'DELETE' })
            } catch (error) {
                // Already gone is what was asked for.
                if (error instanceof VersionApiError && error.status === 404) return
                throw error
            }
        },
    }
}
