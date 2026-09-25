/**
 * The [[Export]]'s scratch files (ADR 0092, decision 5).
 *
 * A browser without a save picker gets its zip written to a file in the Origin Private File
 * System and then downloaded from that file's object URL. A page is never told when such a
 * download finishes, and deleting the file under a running one breaks it, so the file cannot be
 * removed at hand-over. Instead: one file per graph, a Web Lock held from the first byte until
 * the archive is handed over or discarded, and a sweep that removes any file whose lock is free
 * and whose last write is older than a grace period. The sweep runs when a graph opens, when an
 * export starts, and on a timer while a graph is open.
 */

import { crossTabLocksAvailable, tryClaimLock } from '$lib/cross-tab-lock'
import { getOpfsRoot } from '$lib/storage/fs/web-fs-adapter'

export const EXPORT_SCRATCH_DIRECTORY = 'etherpk-export'
/** How long a handed-over file is left for its download before a sweep may take it. */
export const EXPORT_SCRATCH_GRACE_MS = 60 * 60 * 1000
export const EXPORT_SCRATCH_SWEEP_INTERVAL_MS = 15 * 60 * 1000

export function scratchFileName(graphId: string): string {
    return `${graphId}.zip`
}

/** The lock a running or undecided export holds, and a sweep tests before deleting. */
export function exportLockName(graphId: string): string {
    return `etherpk-export:${graphId}`
}

/** The graph a scratch file belongs to, or null for a file that is not one of ours. */
export function graphIdOfScratchFile(name: string): string | null {
    return name.endsWith('.zip') && name.length > 4 ? name.slice(0, -4) : null
}

export interface ScratchFile {
    name: string
    size: number
    lastModified: number
}

/** The scratch directory as the sweep and the tab see it. */
export interface ScratchStore {
    list(): Promise<ScratchFile[]>
    remove(name: string): Promise<void>
}

export function opfsScratchStore(): ScratchStore {
    async function directory(): Promise<FileSystemDirectoryHandle> {
        return (await getOpfsRoot()).getDirectoryHandle(EXPORT_SCRATCH_DIRECTORY, { create: true })
    }
    return {
        async list() {
            const out: ScratchFile[] = []
            for await (const handle of (await directory()).values()) {
                if (handle.kind !== 'file') continue
                const file = await (handle as FileSystemFileHandle).getFile()
                out.push({ name: handle.name, size: file.size, lastModified: file.lastModified })
            }
            return out
        },
        async remove(name) {
            await (await directory()).removeEntry(name).catch((error: unknown) => {
                if ((error as DOMException).name !== 'NotFoundError') throw error
            })
        },
    }
}

/**
 * Whether a scratch file is being written or awaits a decision. Its export holds the lock; a
 * lock that can be taken and given straight back is held by nobody. Without Web Locks nothing
 * can hold one, so nothing is in use.
 */
export async function scratchFileInUse(name: string): Promise<boolean> {
    const graphId = graphIdOfScratchFile(name)
    if (!graphId || !crossTabLocksAvailable()) return false
    const release = await tryClaimLock(exportLockName(graphId))
    if (!release) return true
    release()
    return false
}

export interface SweepDeps {
    store: ScratchStore
    inUse?: (name: string) => Promise<boolean>
    now?: () => number
    graceMs?: number
}

/** Remove every scratch file nobody is using whose last write is older than the grace. Returns what went. */
export async function sweepExportScratch(deps: SweepDeps): Promise<string[]> {
    const now = deps.now ?? (() => Date.now())
    const grace = deps.graceMs ?? EXPORT_SCRATCH_GRACE_MS
    const inUse = deps.inUse ?? scratchFileInUse
    const removed: string[] = []
    for (const file of await deps.store.list()) {
        if (now() - file.lastModified < grace) continue
        if (await inUse(file.name)) continue
        await deps.store.remove(file.name)
        removed.push(file.name)
    }
    return removed
}

/** This graph's scratch file when one is on the device and nobody is using it, for the tab to name. */
export async function leftoverExportFor(
    graphId: string,
    store: ScratchStore,
    inUse: (name: string) => Promise<boolean> = scratchFileInUse,
): Promise<ScratchFile | null> {
    const name = scratchFileName(graphId)
    const file = (await store.list()).find((entry) => entry.name === name)
    if (!file || (await inUse(name))) return null
    return file
}
