/**
 * The [[Quick Note]]s of a [[Filesystem Backend]] graph: `etherpk/quick-notes.json` (ADR 0078).
 * Beside `settings.json`, not inside it, so the file is the same shape a [[Local Mirror]]
 * writes for a synced graph and an [[Export]] carries. One browser owns the folder, so there is
 * no concurrent peer here and the whole list is written each time.
 *
 * Read/write go through the {@link DirectoryAdapter} seam, so this is pure and Node-testable
 * over the in-memory adapter. A missing or malformed file reads as no notes.
 */

import { type QuickNote, sanitizeQuickNotes } from '$lib/document/quick-notes'

import type { DirectoryAdapter } from './directory-adapter'

/** The notes file under the graph's `etherpk/` folder. */
export const QUICK_NOTES_FILE = 'quick-notes.json'

/** The file's text for `notes`: pretty-printed, newline-terminated, the mirror's shape too. */
export function quickNotesFileText(notes: readonly QuickNote[]): string {
    return `${JSON.stringify(sanitizeQuickNotes(notes), null, 2)}\n`
}

export async function readQuickNotes(adapter: DirectoryAdapter): Promise<QuickNote[]> {
    try {
        const { text } = await adapter.read('etherpk', QUICK_NOTES_FILE)
        return sanitizeQuickNotes(JSON.parse(text))
    } catch {
        return []
    }
}

export async function writeQuickNotes(adapter: DirectoryAdapter, notes: readonly QuickNote[]): Promise<void> {
    await adapter.write('etherpk', QUICK_NOTES_FILE, quickNotesFileText(notes))
}
