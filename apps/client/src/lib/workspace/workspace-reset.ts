/**
 * Reset workspace: the per-device state that goes when a user asks for the workspace "as a
 * brand-new graph opens with" (2026-09-18).
 *
 * What goes is the ARRANGEMENT and what hangs off it: the [[Layout]] itself (panes, tabs, pins,
 * Sidebar collapse, dockview geometry), the [[Reading Position]]s of Views that no longer exist,
 * and the two Sidebar View states that are arrangement in all but name: the Backlinks pin and the
 * Tasks filter. What stays is everything a user READS or WROTE or CHOSE: [[Recents]] (activity,
 * not arrangement), the unsent Quick Note text, the editor font size (a preference over every
 * graph), the Backlinks preferences (Highlight reference and the fold of the backlinks beneath
 * documents, ADR 0135), and of course all shared graph content.
 *
 * The person's [[Sidebar Arrangement]] goes back to its defaults too (ADR 0199, amended 2026-11-23).
 * It is one setting for every graph, Plain Folder and device, so the confirmation says the Sidebars
 * change everywhere. The workspace resets it, through the binding that keeps the Layout in step.
 *
 * The Layout is not cleared here: the workspace restores `defaultLayout()` over a fresh
 * presenter and saves it, which is one write rather than a delete and a write. This clears the
 * localStorage keys of the companions that go, so the stores the workspace creates next start
 * from their defaults. The Backlinks pin is never stored: the reset recreates the Backlinks store,
 * which reads the kept preferences back and starts unpinned.
 */

import { TASK_FILTER_KEY_PREFIX } from '#lib/document/task-filter-store.js'
import { READING_POSITIONS_KEY_PREFIX } from '#lib/navigation/reading-positions.js'

/** What Reset workspace asks first, in a graph and in a Plain Folder. */
export const RESET_WORKSPACE_PROMPT = {
    title: 'Reset workspace?',
    message:
        'Closes every tab here, and puts both sidebars and their views back to the defaults. The sidebars change in every graph and folder you open, and on your other devices for synced graphs.',
    confirmLabel: 'Reset',
} as const

/** The per-graph keys a reset forgets, so a test can assert the exact set. */
export function workspaceResetKeys(graphId: string): string[] {
    return [
        `${READING_POSITIONS_KEY_PREFIX}${graphId}`,
        `${TASK_FILTER_KEY_PREFIX}${graphId}`,
    ]
}

export function forgetWorkspaceCompanions(graphId: string, storage: Storage | undefined = globalThis.localStorage): void {
    if (!storage) return
    for (const key of workspaceResetKeys(graphId)) storage.removeItem(key)
}
