/**
 * Materialise a {@link ConvertedGraph} into a just-created Server-Backend graph over an
 * open {@link GraphSync} session (the wizard owns creation, keys, and the session's
 * lifecycle - this writes and flushes).
 *
 * Destination-specific shape: a server document's identity lives in the encrypted root
 * registry (ADR 0024), and its Frontmatter is a proposal about it (ADR 0061). The title and
 * aliases go to the registry; the block keeps its other keys and, when those keep it, its
 * aliases, so block and registry agree from the start. Assets upload
 * through the server Asset store, which mints its own `stem.<uuid>.ext` refs (ADR 0027);
 * document references rewrite from the converter's content-hash refs to the minted ones.
 * The [[Graph Name]] and Graph Settings land in the root `meta` map (ADR 0031) - safe to
 * write without a catchup gate here because the graph was created seconds ago and has no
 * history to clobber.
 *
 * The final phase waits for the SERVER'S ACKS, not merely for the socket to accept the
 * bytes (ADR 0035 §2). `flushAll` alone resolves once documents are encrypted, cached and
 * handed to `send` - declaring success there would be a claim we have not checked, with
 * the socket closed moments later on a still-draining buffer.
 */

import { mapWithPool } from '$lib/concurrency'
import type { AssetStore } from '$lib/storage/fs/asset-store'
import { frontmatterIdentity, syncedImportText } from '$lib/document/frontmatter/identity'
import { sanitizeGraphSettings } from '$lib/storage/fs/graph-settings'
import type { GraphSync, RegistryEntry } from '$lib/sync/graph-sync'
import type { ProtectionRecordStore } from '$lib/document/protection/protection-store'

import { buildReportPage } from './report'
import { AssetRefusedError } from '$lib/storage/server/server-asset-store'

/**
 * How many assets may fail for reasons OTHER than their own size before the import is abandoned,
 * given none has succeeded. A per-asset refusal is a statement about one file - a graph whose
 * only four assets are all too large still imports, with four report entries - whereas repeated
 * failures with nothing getting through mean a dropped connection or a dead session, and the
 * graph is not worth keeping.
 */
const ABANDON_AFTER_SYSTEMIC_FAILURES = 3

/** An asset the server would not store, kept out of the graph and named in the Import Report. */
export interface SkippedAsset {
    fileName: string
    bytes: number
    /** The policy that refused it, when the refusal was a typed one rather than a failure. */
    code: string | null
    detail: string
}
import { breathe, type ConvertedGraph, type ImportControl, type ImportFormat } from './types'

/**
 * Assets uploaded at once. Each costs three round trips (begin, chunk PUTs, complete), so
 * the serial loop was latency-bound rather than bandwidth-bound; six recovers most of that
 * without hammering the relay or the bucket.
 */
const UPLOAD_CONCURRENCY = 6

/**
 * Combined size of in-flight uploads. `save` reads each asset fully into memory, and the
 * live drive measured a 724 MB peak heap on a graph whose largest assets were 100-153 MB -
 * six of those at once would trade a latency win for an out-of-memory. A single asset
 * larger than this budget still uploads; it just runs on its own.
 */
const MAX_UPLOAD_BYTES_IN_FLIGHT = 64 * 1024 * 1024

export interface ServerMaterializeDeps {
    graph: GraphSync
    /** The server Asset store for the new graph; unused when the source had no assets. */
    assetStore: AssetStore | null
    /** The [[Graph Name]] chosen in the wizard. */
    name: string
    /**
     * Where the new graph's protection record goes (ADR 0093): the account vault under the new
     * graph id. Absent when the caller has no vault to offer, in which case a record the source
     * carried is reported as not carried over rather than dropped in silence.
     */
    protection?: ProtectionRecordStore | null
    newDocId?: () => string
}

export interface ServerMaterializeResult {
    /** Assets the server would not store. The import kept everything else. */
    skippedAssets: SkippedAsset[]
    /** False when the ack wait gave up: everything is pushed and cached, but the server
     *  has not confirmed all of it. The caller still registers the graph - see ADR 0035 §4. */
    fullyAcked: boolean
    ackedDocuments: number
    totalDocuments: number
}

export async function materializeToServer(
    converted: ConvertedGraph,
    deps: ServerMaterializeDeps,
    options: {
        format: ImportFormat
        reportDate: string
        control?: ImportControl
        ackStallMs?: number
        /** Test seam; defaults to {@link UPLOAD_CONCURRENCY}. */
        uploadConcurrency?: number
    },
): Promise<ServerMaterializeResult> {
    const { control } = options
    const onProgress = control?.onProgress
    const newDocId = deps.newDocId ?? (() => crypto.randomUUID())

    // Assets first: uploads mint the refs the documents must carry. Measured in bytes, so
    // a few large files move the bar instead of freezing a per-file counter, and uploaded
    // with bounded concurrency - serial upload was 84% of a synced import's wall-clock.
    const refMap = new Map<string, string>()
    const assetBytes = converted.assets.reduce((sum, a) => sum + a.data.size, 0)
    let uploaded = 0
    let completed = 0
    let stored = 0
    let systemicFailures = 0
    const skipped: SkippedAsset[] = []
    if (converted.assets.length > 0) {
        onProgress?.({ label: 'Uploading assets', done: 0, total: assetBytes, unit: 'bytes' })
    }

    await mapWithPool(
        converted.assets,
        async (asset) => {
            if (!deps.assetStore) throw new Error('materializeToServer: assets present but no asset store')
            try {
                const bytes = new Uint8Array(await asset.data.arrayBuffer())
                const saved = await deps.assetStore.save(
                    {
                        name: asset.fileName,
                        bytes,
                        type: asset.data.type || 'application/octet-stream',
                    },
                    (delta) => {
                        uploaded += delta
                        onProgress?.({ label: 'Uploading assets', done: uploaded, total: assetBytes, unit: 'bytes' })
                    },
                )
                // Reconcile on completion: an AssetStore is not obliged to report byte deltas,
                // and without this the bar would sit at zero for one that does not.
                completed += asset.data.size
                if (uploaded < completed) {
                    uploaded = completed
                    onProgress?.({ label: 'Uploading assets', done: uploaded, total: assetBytes, unit: 'bytes' })
                }
                // A Map keyed by the source ref, so completion order does not matter.
                refMap.set(`../assets/${asset.fileName}`, saved.ref)
                stored += 1
            } catch (err) {
                // A refusal that condemns every other asset too - no room, or no active plan -
                // abandons the import here rather than uploading hundreds of files that cannot land.
                if (err instanceof AssetRefusedError && !err.isPerAsset) {
                    throw new Error(`uploading asset "${asset.fileName}" failed: ${err.message}`)
                }
                skipped.push({
                    fileName: asset.fileName,
                    bytes: asset.data.size,
                    code: err instanceof AssetRefusedError ? err.code : null,
                    detail: (err as Error).message,
                })
                if (!(err instanceof AssetRefusedError)) systemicFailures += 1
                // Nothing at all is getting through: the graph is not worth keeping, and the
                // caller's unwind removes what has already been written.
                if (stored === 0 && systemicFailures >= ABANDON_AFTER_SYSTEMIC_FAILURES) {
                    throw new Error(
                        `uploading assets failed ${systemicFailures} times with none succeeding - last: "${asset.fileName}" ${(err as Error).message}`,
                    )
                }
            }
        },
        {
            limit: options.uploadConcurrency ?? UPLOAD_CONCURRENCY,
            maxBytesInFlight: MAX_UPLOAD_BYTES_IN_FLIGHT,
            sizeOf: (asset) => asset.data.size,
            signal: control?.signal,
        },
    )

    // The Import Report carries storage refusals beside conversion losses: the conversion
    // succeeded here, so this is the only place the user would otherwise never learn of it.
    for (const asset of skipped) {
        converted.report.push({
            category: 'not-stored',
            detail: `"${asset.fileName}" (${formatSize(asset.bytes)}) was not uploaded: ${asset.detail}. Documents that reference it still point at the original file.`,
        })
    }

    // The source's protection record becomes this graph's own (ADR 0093). Before the report page
    // is built, so a vault that will not take it is named there: the documents still arrive, and
    // "unreadable here" is something the person can act on, silence is not.
    if (converted.protection) {
        if (!deps.protection) {
            converted.report.push({
                category: 'unsupported',
                detail: 'The graph’s protection record was not carried over, so its protected documents stay unreadable here.',
            })
        } else {
            try {
                await deps.protection.write(converted.protection)
            } catch (err) {
                converted.report.push({
                    category: 'unsupported',
                    detail: `The graph’s protection record could not be stored in your account vault (${(err as Error).message}), so its protected documents stay unreadable here. Import the folder again once the vault is reachable.`,
                })
            }
        }
    }

    const registry = deps.graph.registry()
    const documents = [...converted.documents, buildReportPage(converted, options.format, options.reportDate)]
    let pushed = 0
    for (const doc of documents) {
        // Y.Text.insert of a whole document is real CPU work; this loop had no await at all,
        // so it held the thread for the entire graph.
        await breathe(control)
        onProgress?.({ label: 'Preparing documents', done: ++pushed, total: documents.length })
        const docId = newDocId()
        // Identity goes into the encrypted registry - the title already did, the aliases now do
        // too - and the rest of the block stays with the document (ADR 0061): a synced graph's
        // Frontmatter means the same as a local one's, and publishing will read it there. The
        // aliases also stay in a block that other keys keep, so the block agrees with the
        // registry and a later edit to it clears nothing.
        const aliases = frontmatterIdentity(doc.text).aliases
        const named = aliases.length > 0 ? { aliases } : {}
        const entry: RegistryEntry =
            doc.kind === 'journal'
                ? { kind: 'journal', date: doc.concept, ...named }
                : { kind: 'page', title: doc.concept, ...named }
        registry.set(docId, entry)
        let text = syncedImportText(doc.text)
        for (const [from, to] of refMap) text = text.split(from).join(to)
        deps.graph.docSync(docId).doc.getText('content').insert(0, text)
    }

    deps.graph.setMetaName(deps.name)
    if (converted.settings) {
        deps.graph.setMetaSettings(sanitizeGraphSettings(converted.settings) as Record<string, unknown>)
    }
    if (converted.quickNotes?.length) {
        // By id, so a note the graph already holds is not added twice (ADR 0078).
        const notes = deps.graph.quickNotes()
        const held = new Set(notes.list().map((n) => n.id))
        for (const note of converted.quickNotes) if (!held.has(note.id)) notes.add(note)
    }
    if (converted.spellingDictionary?.length) {
        // A set: a word the graph already holds is simply set again (ADR 0095).
        const dictionary = deps.graph.spellingDictionary()
        for (const word of converted.spellingDictionary) dictionary.add(word)
    }
    if (converted.themes?.length) {
        // By id, the graph's own copy kept, as on a folder (ADR 0082).
        const themes = deps.graph.themes()
        for (const theme of converted.themes) if (!themes.get(theme.id)) themes.put(theme)
    }

    const total = documents.length + 1 // + the graph-root doc (registry + meta)
    onProgress?.({ label: 'Sending changes', done: 0, total })
    await deps.graph.flushAll({
        onProgress: (flushed) => onProgress?.({ label: 'Sending changes', done: flushed, total }),
    })
    onProgress?.({ label: 'Sending changes', done: total, total })
    onProgress?.({ label: 'Syncing changes', done: 0, total })
    const acked = await deps.graph.awaitAcked({
        onProgress: (outstanding) => onProgress?.({ label: 'Syncing changes', done: total - outstanding, total }),
        signal: control?.signal,
        stallMs: options.ackStallMs,
    })
    // A final tick: when everything was acked before the wait even started, `awaitAcked`
    // returns without emitting and the phase would otherwise be left showing 0.
    onProgress?.({ label: 'Syncing changes', done: total - acked.outstanding, total })

    return {
        fullyAcked: acked.settled,
        ackedDocuments: total - acked.outstanding,
        totalDocuments: total,
        skippedAssets: skipped,
    }
}

/** Sizes in a user-facing sentence, where "536870912 bytes" helps nobody. */
function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
