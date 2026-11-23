/**
 * The [[Quick Note]]s of a [[Filesystem Backend]] graph: `etherpk/quick-notes.json` (ADR 0078).
 * Beside `settings.json`, not inside it, so the file is the same shape a [[Local Mirror]]
 * writes for a synced graph and an [[Export]] carries. One browser owns the folder, so there is
 * no concurrent peer here and the whole list is written each time.
 *
 * Read/write go through the {@link DirectoryAdapter} seam, so this is pure and Node-testable
 * over the in-memory adapter. A missing or malformed file reads as no notes.
 */

import { type QuickNote, type QuickNotesPersist, sanitizeQuickNotes } from '#lib/document/quick-notes.js'

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

/**
 * The open graph's list, kept in the file. Each change is written whole, over the list as the
 * change before it left it and after that write has ended, and a write that is refused changes
 * nothing: the note goes back to the person, and a later write must not save it as well.
 */
export function quickNotesFilePersist(adapter: DirectoryAdapter, initial: readonly QuickNote[]): QuickNotesPersist {
    let notes = initial
    let turn: Promise<void> = Promise.resolve()
    const change = (make: (notes: readonly QuickNote[]) => readonly QuickNote[]): Promise<void> => {
        const write = turn.then(async () => {
            const next = make(notes)
            await writeQuickNotes(adapter, next)
            notes = next
        })
        turn = write.catch(() => {})
        return write
    }
    return {
        add: (note) => change((held) => [...held, note]),
        remove: (ids) => {
            const gone = new Set(ids)
            return change((held) => held.filter((note) => !gone.has(note.id)))
        },
    }
}
