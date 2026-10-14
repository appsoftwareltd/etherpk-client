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
 * The Layout is not cleared here: the workspace restores `defaultLayout()` over a fresh
 * presenter and saves it, which is one write rather than a delete and a write. This clears the
 * localStorage keys of the companions that go, so the stores the workspace creates next start
 * from their defaults. The Backlinks pin is never stored: the reset recreates the Backlinks store,
 * which reads the kept preferences back and starts unpinned.
 */

import { TASK_FILTER_KEY_PREFIX } from '$lib/document/task-filter-store'
import { READING_POSITIONS_KEY_PREFIX } from '$lib/navigation/reading-positions'

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
