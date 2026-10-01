/**
 * The seam between the [[Import]] subsystem and the [[Activity]] store: it owns the phase
 * vocabulary, maps the converters'/materialisers' `label` ticks onto phase indices, and
 * turns the run's outcome into what the [[Activity Toast]] shows.
 *
 * Deliberately one-directional - nothing under `lib/import/` imports the Activity store.
 * The import pipeline reports labels and knows nothing about toasts, which is what lets it
 * stay node-testable and run inside a Worker.
 */

import { createBreather } from '$lib/activity/breathe'
import { runActivity, type ActivityHandle, type ActivityOutcome } from '$lib/activity/store'
import { importMarkers, type ImportMarker, type StartedImport } from './import-marker'
import type { Activity, ActivityPhase } from '$lib/activity/types'
import type { GraphRegistry } from '$lib/storage/graph-registry'

import { convertInWorker, type WorkerFactory } from './convert-client'
import {
    runFilesystemImport,
    runServerImport,
    type ServerImportDeps,
    type ServerImportResult,
} from './run-import'
import type { ImportControl, ImportFormat, ImportProgress, SourceFile } from './types'

/**
 * The phases, in the order each converter actually runs them. The labels are a contract
 * with the converters and materialisers: they are matched by string to find the phase
 * index. Counts are known before each phase begins, so "Step 3 of 6" and each bar are
 * honest without inventing weights for an overall bar.
 *
 * The order is per-FORMAT, not shared, because the converters genuinely differ: Logseq and
 * Obsidian plan assets before reading markdown, while EtherPK converts first and plans
 * assets afterwards. A single shared list made the step counter run backwards (caught on
 * the live drive: "Step 2 of 6" was followed by "Step 1 of 6").
 */
const PREPARING_ASSETS: ActivityPhase = { label: 'Preparing assets', unit: 'bytes' }
const CONVERTING: ActivityPhase = { label: 'Converting documents', unit: 'items' }
const READING: ActivityPhase = { label: 'Reading files', unit: 'items' }

const CONVERT_PHASES: Record<ImportFormat, ActivityPhase[]> = {
    logseq: [PREPARING_ASSETS, READING, { label: 'Indexing references', unit: 'items' }, CONVERTING],
    obsidian: [PREPARING_ASSETS, READING, CONVERTING],
    markdown: [PREPARING_ASSETS, READING, CONVERTING], // the Obsidian pipeline
    etherpk: [CONVERTING, PREPARING_ASSETS],
    asnotes: [PREPARING_ASSETS, READING, CONVERTING],
}

const FILESYSTEM_TAIL: ActivityPhase[] = [
    { label: 'Writing documents', unit: 'items' },
    { label: 'Writing assets', unit: 'bytes' },
]

const SERVER_TAIL: ActivityPhase[] = [
    { label: 'Uploading assets', unit: 'bytes' },
    { label: 'Preparing documents', unit: 'items' },
    { label: 'Sending changes', unit: 'items' },
    { label: 'Syncing changes', unit: 'items' },
]

export function phasesFor(format: ImportFormat, destination: 'filesystem' | 'server'): ActivityPhase[] {
    return [...CONVERT_PHASES[format], ...(destination === 'server' ? SERVER_TAIL : FILESYSTEM_TAIL)]
}

/**
 * Build the {@link ImportControl} an import run threads everywhere: progress mapped onto
 * the Activity's phases, the cancel signal, and the shared yield budget.
 */
function controlFor(handle: ActivityHandle, phases: ActivityPhase[]): ImportControl {
    const indexOf = new Map(phases.map((p, i) => [p.label, i]))
    const breathe = createBreather()
    let current = 0
    return {
        signal: handle.signal,
        breathe,
        onProgress: (progress: ImportProgress) => {
            // An unknown label keeps the current phase rather than snapping to 0, which
            // would make the step counter jump backwards.
            current = indexOf.get(progress.label) ?? current
            handle.report({ phase: current, done: progress.done, total: progress.total })
        },
    }
}

export interface FilesystemImportRequest {
    kind: 'filesystem'
    handle: FileSystemDirectoryHandle
    registry: GraphRegistry
}

export interface ServerImportRequest {
    kind: 'server'
    deps: Omit<ServerImportDeps, 'name'>
}

export interface StartImportOptions {
    files: SourceFile[]
    format: ImportFormat
    name: string
    reportDate: string
    destination: FilesystemImportRequest | ServerImportRequest
    /** Where "Open" takes the user once the Activity finishes. Never runs on its own. */
    onOpen: (result: { graphId: string } | ServerImportResult) => void
    /** Runs the moment the import succeeds, before the user does anything: caches the
     *  device key and, on a fresh account, starts the Recovery Code ritual (ADR 0029). */
    onSettled?: (result: { graphId: string } | ServerImportResult) => void
    /** Test seams. */
    createWorker?: WorkerFactory | null
    ackStallMs?: number
    /** Test seam; defaults to this page's markers over localStorage (import-marker.ts). */
    markers?: Pick<ReturnType<typeof importMarkers>, 'start'>
}

/**
 * What an import's marker records before it starts: enough for the Knowledge graphs page to say
 * what a cut-off import left and to clear it up - the folder written into, or the Sync Server the
 * partial graph is on.
 */
export function importMarkerFields(
    name: string,
    destination: FilesystemImportRequest | ServerImportRequest,
): Omit<ImportMarker, 'id' | 'startedAt'> {
    return destination.kind === 'filesystem'
        ? { name, destination: 'filesystem', folderName: destination.handle.name }
        : { name, destination: 'server', serverOrigin: destination.deps.serverScope.serverOrigin }
}

/**
 * Start an import as a background Activity and resolve when it finishes. The caller does
 * NOT await this to keep a dialog open - the wizard closes immediately and the toast takes
 * over (ADR 0035 §1).
 *
 * Rejects only on {@link ActivityConflictError} (an import already running); a failed
 * import is a normal Activity outcome reported by its toast, not an exception.
 */
export function startImport(options: StartImportOptions): Promise<Activity> {
    const phases = phasesFor(options.format, options.destination.kind)

    return runActivity({
        kind: 'import',
        title: `Importing "${options.name}"`,
        failureTitle: `Import cancelled - "${options.name}"`,
        phases,
        run: async (handle) => {
            // Marked until it settles, so a tab closed or reloaded partway leaves a note the
            // Knowledge graphs page reads, with what to clear up.
            const marker = (options.markers ?? importMarkers()).start(importMarkerFields(options.name, options.destination))
            try {
                return await runImport(options, phases, handle, marker)
            } finally {
                marker.clear()
                // The Protection Key the wizard unwrapped is needed only while documents are
                // written, and the run is over: overwrite it rather than wait for collection.
                if (options.destination.kind === 'server') options.destination.deps.protectionKey?.fill(0)
            }
        },
    })
}

async function runImport(
    options: StartImportOptions,
    phases: ActivityPhase[],
    handle: ActivityHandle,
    marker: StartedImport,
): Promise<ActivityOutcome> {
    const control = controlFor(handle, phases)
    // Show the first phase's label immediately, uncounted: spawning the worker and
    // reaching its first tick is otherwise a visibly blank toast.
    handle.beginPhase(0, 0)

    const converted =
        options.createWorker === undefined
            ? await convertInWorker(options.files, options.format, control)
            : await convertInWorker(options.files, options.format, control, options.createWorker)

    const runOptions = { format: options.format, reportDate: options.reportDate, control, ackStallMs: options.ackStallMs }

    if (options.destination.kind === 'filesystem') {
        const result = await runFilesystemImport(
            converted,
            { handle: options.destination.handle, registry: options.destination.registry, name: options.name },
            runOptions,
        )
        options.onSettled?.(result)
        return {
            title: `Imported "${options.name}"`,
            detail: summary(converted.documents.length, converted.assets.length),
            action: { label: 'Open', run: () => options.onOpen(result) },
        }
    }

    const result = await runServerImport(
        converted,
        { ...options.destination.deps, name: options.name, onGraphCreated: (graphId) => marker.setGraphId(graphId) },
        runOptions,
    )
    options.onSettled?.(result)
    const missing = result.skippedAssets.length
    return {
        title: `Imported "${options.name}"`,
        ...serverImportOutcome({ ...result, missing }, converted.documents.length, converted.assets.length),
        action: missing > 0 && result.retryAssets
            ? { label: 'Retry uploads', run: () => void retryUploads(options, result) }
            : { label: 'Open', run: () => options.onOpen(result) },
    }
}

/**
 * The retry is its own Activity, not a mutation of the finished one: it does real work with its
 * own progress and its own outcome, and the toast model gives each Activity one action - so this
 * is also how the user gets an Open button back once the files are in.
 */
function retryUploads(options: StartImportOptions, result: ServerImportResult): Promise<Activity> {
    return runActivity({
        kind: 'import',
        title: `Retrying uploads for "${options.name}"`,
        phases: [{ label: 'Uploading assets', unit: 'bytes' }],
        run: async () => {
            const outcome = await result.retryAssets!()
            const stuck = outcome.stillFailed.length
            return {
                title: `Imported "${options.name}"`,
                state: stuck === 0 ? 'done' : 'partial',
                detail: stuck === 0
                    ? `All ${outcome.uploaded.length === 1 ? 'file' : `${outcome.uploaded.length} files`} uploaded - the documents now point at them.`
                    : `${outcome.uploaded.length} uploaded, ${stuck} still refused. The import report lists what is missing.`,
                action: { label: 'Open', run: () => options.onOpen(result) },
            }
        },
    })
}

/**
 * What a synced import's toast says when it ends. A stall is a weaker claim, not a failure: the
 * content is in the Local Cache and drains on the next open (ADR 0035 §4), and it comes first,
 * since until the server has confirmed every document "the rest of the graph is here" is not
 * yet true. Files the server would not store are the same shape of claim: the graph, minus those.
 */
export function serverImportOutcome(
    result: { fullyAcked: boolean; ackedDocuments: number; totalDocuments: number; missing: number },
    documents: number,
    assets: number,
): { state: 'done' | 'partial'; detail: string } {
    const { missing } = result
    const notUploaded = `${missing === 1 ? '1 file' : `${missing} files`} could not be uploaded and ${missing === 1 ? 'is' : 'are'} listed in the import report`
    if (!result.fullyAcked) {
        const syncing = `Still syncing to the server - ${result.ackedDocuments} of ${result.totalDocuments} confirmed. It will finish in the background.`
        return { state: 'partial', detail: missing > 0 ? `${syncing} ${notUploaded}.` : syncing }
    }
    if (missing > 0) return { state: 'partial', detail: `${notUploaded} - the rest of the graph is here.` }
    return { state: 'done', detail: summary(documents, assets) }
}

function summary(documents: number, assets: number): string {
    const docs = `${documents} ${documents === 1 ? 'document' : 'documents'}`
    if (assets === 0) return docs
    return `${docs}, ${assets} ${assets === 1 ? 'asset' : 'assets'}`
}
