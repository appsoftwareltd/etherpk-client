/**
 * An [[Export]]: the mirror pass, run once, streamed into a zip (ADR 0092).
 *
 * `createLocalMirror` already knows how a graph becomes a folder - names and collisions, the
 * identity block in each file, which assets the graph holds and what to call them, what is a
 * dangling link, and that unconfirmed content is skipped and named rather than written empty.
 * The export runs that pass over a {@link createZipDirectoryAdapter} and reads the report out of
 * the mirror's own status. No retries of the pass: an archive cannot be rewound, so the first
 * failure is final and the sink is discarded. Downloads are retried within the run instead.
 *
 * The archive is finished but not handed over. Whether the person gets it is the caller's
 * decision once the report says what, if anything, is missing (ADR 0092, decision 6).
 */

import { withRetry, type RetryOptions } from '$lib/retry'
import { createZipWriter, type ZipSink } from '$lib/zip/zip-writer'

import {
    createLocalMirror,
    type LocalMirror,
    type MirrorAssetResult,
    type MirrorDanglingLink,
    type MirrorNameCollision,
    type MirrorSource,
    type MirrorStatus,
} from '../local-mirror'
import { createZipDirectoryAdapter } from './zip-directory-adapter'

/** Where the archive's bytes go, and what becomes of them once it is complete. */
export interface ExportSink extends ZipSink {
    /** The archive is complete. Keep it until the caller hands it over or discards it. */
    finish(): Promise<void>
    /** Throw the archive away: nothing written is kept. */
    discard(): Promise<void>
}

export interface ExportReport {
    documents: number
    assets: number
    bytes: number
    /** Concepts whose content could not be confirmed, so they are not in the archive. */
    skipped: string[]
    /** Attachments the graph holds that could not be downloaded, so they are not in the archive. */
    missingAssets: string[]
    /** Links to attachments the graph does not hold: a fact about the graph, not a gap in the copy. */
    danglingLinks: MirrorDanglingLink[]
    collisions: MirrorNameCollision[]
    /** True when nothing the graph holds was left out. */
    complete: boolean
}

export interface GraphExportDeps {
    source: MirrorSource
    sink: ExportSink
    /** The single top-level folder inside the zip. */
    rootName: string
    now?: () => number
    assetConcurrency?: number
    /** How a failed download is retried within the run. Tests inject an instant sleep. */
    retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'sleep'>
    onProgress?: (status: MirrorStatus) => void
}

export interface GraphExportRun {
    /** The report once the archive is finished. Rejects on failure, or with {@link ExportCancelledError}. */
    done: Promise<ExportReport>
    /** Halt between files and discard whatever was written. */
    cancel(): void
}

export class ExportCancelledError extends Error {
    constructor() {
        super('the export was cancelled')
        this.name = 'ExportCancelledError'
    }
}

const DEFAULT_DOWNLOAD_ATTEMPTS = 3
const DEFAULT_DOWNLOAD_BASE_DELAY_MS = 500

/** A pass over an archive cannot try again later, so a download that failed this once is tried now. */
function withDownloadRetries(source: MirrorSource, retry: GraphExportDeps['retry']): MirrorSource {
    const { fetchAsset } = source
    if (!fetchAsset) return source
    const unavailable = new Error('unavailable')
    return {
        ...source,
        fetchAsset: (assetId): Promise<MirrorAssetResult> =>
            withRetry(
                async () => {
                    const result = await fetchAsset(assetId)
                    if (result === 'unavailable') throw unavailable
                    return result
                },
                {
                    attempts: retry?.attempts ?? DEFAULT_DOWNLOAD_ATTEMPTS,
                    baseDelayMs: retry?.baseDelayMs ?? DEFAULT_DOWNLOAD_BASE_DELAY_MS,
                    ...(retry?.sleep ? { sleep: retry.sleep } : {}),
                },
            ).catch((error: unknown) => (error === unavailable ? 'unavailable' : Promise.reject(error))),
    }
}

export function runGraphExport(deps: GraphExportDeps): GraphExportRun {
    let cancelled = false
    let mirror: LocalMirror | undefined

    const done = (async (): Promise<ExportReport> => {
        try {
            // Attachments come from the server, so an export that cannot ask it what the graph
            // holds cannot be complete, and says so before writing a byte.
            if (deps.source.listGraphAssets && (await deps.source.listGraphAssets()) === null) {
                throw new Error('Export needs a connection to the Sync Server: attachments are downloaded from it.')
            }
            if (cancelled) throw new ExportCancelledError()
            const writer = createZipWriter(deps.sink, deps.now ? { now: deps.now } : {})
            const adapter = createZipDirectoryAdapter(writer, { root: deps.rootName, ...(deps.now ? { now: deps.now } : {}) })
            mirror = createLocalMirror(withDownloadRetries(deps.source, deps.retry), adapter, {
                retryDelaysMs: [],
                ...(deps.assetConcurrency ? { assetConcurrency: deps.assetConcurrency } : {}),
                ...(deps.now ? { now: deps.now } : {}),
            })
            const unsubscribe = mirror.onStatus((status) => deps.onProgress?.(status))
            await mirror.sync()
            unsubscribe()
            const status = mirror.status()
            if (cancelled) throw new ExportCancelledError()
            if (status.paused) throw new Error(status.paused.message)
            await adapter.close()
            await deps.sink.finish()
            return {
                documents: status.documents,
                assets: status.assets,
                bytes: writer.bytesWritten,
                skipped: status.skipped,
                missingAssets: status.missingAssets,
                danglingLinks: status.danglingLinks,
                collisions: status.collisions,
                complete: status.skipped.length === 0 && status.missingAssets.length === 0,
            }
        } catch (error) {
            await deps.sink.discard().catch(() => {})
            throw error
        } finally {
            mirror?.dispose()
        }
    })()

    return {
        done,
        cancel() {
            cancelled = true
            mirror?.stop()
        },
    }
}
