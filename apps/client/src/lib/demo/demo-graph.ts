/**
 * The [[Demo Graph]]'s identity and lifecycle (ADR 0069).
 *
 * One fixed id, so `/demo` is idempotent: a revisit reopens what is there, and a reset or a
 * browser eviction rebuilds under the same id. The registry record is the commit marker: it
 * is written LAST, after the folder is complete, so an interrupted seed leaves no record and
 * the next visit rebuilds rather than opening half a graph. The record without its folder is
 * the eviction case, and rebuilds the same way.
 *
 * A rebuild pulls the folder and the derived index out from under whatever might hold them,
 * so it first claims the graph's index-owner lock (the ADR 0042 election). Held elsewhere
 * means the demo is open in another tab, and the answer is `held`, not a stolen lock.
 */
import { discardIndexPool, type DiscardIndexPoolResult } from '$lib/document/index-pool-discard'
import { indexOwnerLockName } from '$lib/document/index-pool-names'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import type { GraphRegistry } from '$lib/storage/graph-registry'
import { opfsGraphFolderName } from '$lib/storage/fs/opfs-graph-folder'

import type { DemoBundleManifest } from './bundle-manifest'
import { type DemoFile, type SeedProgress, materializeDemoGraph } from './seed'

export const DEMO_GRAPH_ID = 'demo-graph'

/** The OPFS folder the demo's files live in; the workspace's dev OPFS convention, reused. */
export const DEMO_GRAPH_FOLDER = opfsGraphFolderName(DEMO_GRAPH_ID)

export function isDemoGraph(graphId: string | null | undefined): boolean {
    return graphId === DEMO_GRAPH_ID
}

export type DemoOpenPlan = 'open' | 'rebuild'

/** Reopen what is there, or rebuild: only a record WITH its folder, and no reset, reopens. */
export function planDemoOpen(state: { hasRecord: boolean; hasFolder: boolean; reset: boolean }): DemoOpenPlan {
    if (state.reset) return 'rebuild'
    return state.hasRecord && state.hasFolder ? 'open' : 'rebuild'
}

export type DemoOpenOutcome =
    /** The demo graph is registered and its folder is complete; open `/g/<id>`. */
    | { kind: 'ready'; plan: DemoOpenPlan }
    /** Another tab holds the demo open, so nothing was touched. */
    | { kind: 'held' }

export interface DemoGraphDeps {
    registry: GraphRegistry
    opfsRoot: () => Promise<FileSystemDirectoryHandle>
    adapterFor: (handle: FileSystemDirectoryHandle) => DirectoryAdapter
    manifest: DemoBundleManifest
    /** The bundle's files, in any order; in the browser, `fetchDemoBundle`. */
    files: (manifest: DemoBundleManifest) => Iterable<DemoFile> | AsyncIterable<DemoFile>
    /** The local day (todayISO), read at the moment of seeding, never cached. */
    today: () => string
    now: () => number
    /** `tryClaimLock` in the browser: the lock now, or null when held elsewhere. */
    claimLock: (name: string) => Promise<(() => void) | null>
    discardIndex?: (graphId: string) => Promise<DiscardIndexPoolResult>
}

function isMissing(error: unknown): boolean {
    return (error as DOMException)?.name === 'NotFoundError'
}

async function folderExists(root: FileSystemDirectoryHandle): Promise<boolean> {
    try {
        await root.getDirectoryHandle(DEMO_GRAPH_FOLDER)
        return true
    } catch (error) {
        if (isMissing(error)) return false
        throw error
    }
}

export async function openDemoGraph(
    deps: DemoGraphDeps,
    options: { reset: boolean; onProgress?: (progress: SeedProgress) => void },
): Promise<DemoOpenOutcome> {
    const root = await deps.opfsRoot()
    const plan = planDemoOpen({
        hasRecord: (await deps.registry.getGraph(DEMO_GRAPH_ID)) !== undefined,
        hasFolder: await folderExists(root),
        reset: options.reset,
    })
    if (plan === 'open') return { kind: 'ready', plan }

    const release = await deps.claimLock(indexOwnerLockName(DEMO_GRAPH_ID))
    if (!release) return { kind: 'held' }
    try {
        await deps.registry.removeGraph(DEMO_GRAPH_ID)
        try {
            await root.removeEntry(DEMO_GRAPH_FOLDER, { recursive: true })
        } catch (error) {
            if (!isMissing(error)) throw error
        }
        const discarded = await (deps.discardIndex ?? discardIndexPool)(DEMO_GRAPH_ID)
        if (discarded.kind === 'held') return { kind: 'held' }

        const handle = await root.getDirectoryHandle(DEMO_GRAPH_FOLDER, { create: true })
        const shift = { anchor: deps.manifest.anchor, today: deps.today(), windowDays: deps.manifest.windowDays }
        await materializeDemoGraph(deps.adapterFor(handle), deps.files(deps.manifest), shift, {
            totalBytes: deps.manifest.totalBytes,
            onProgress: options.onProgress,
        })
        await deps.registry.insertGraph({
            id: DEMO_GRAPH_ID,
            name: deps.manifest.name,
            backend: 'filesystem',
            createdAt: deps.now(),
            handle,
        })
        return { kind: 'ready', plan }
    } finally {
        release()
    }
}
