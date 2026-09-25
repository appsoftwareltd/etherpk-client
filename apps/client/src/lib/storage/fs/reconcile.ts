/**
 * The external-change decision for one open document — the heart of the git
 * workflow (DESIGN.md → The git workflow): never silently merge, never do git's
 * job. Pure.
 *
 * The decision is by *text equality*, not mtime: `baseText` is the text we last
 * synced with disk (seeded on open, updated on every successful save). The mtime
 * is only a fast-path the store uses to skip reading unchanged files — so a
 * coarse or browser-managed mtime can at worst cost an extra read, never a missed
 * reload.
 */

export interface ReconcileInput {
    /** Does the live buffer hold unsaved local edits? */
    dirty: boolean
    /** The text we last synced with disk. */
    baseText: string
    /** The text currently on disk. */
    diskText: string
}

export type ReconcileDecision = 'noop' | 'reload' | 'conflict'

export function reconcileDecision({ dirty, baseText, diskText }: ReconcileInput): ReconcileDecision {
    if (diskText === baseText) return 'noop' // disk matches our last sync (includes our own write)
    if (!dirty) return 'reload' // clean buffer + external edit → reflect it
    return 'conflict' // unsaved edits + external edit → stop and ask
}
