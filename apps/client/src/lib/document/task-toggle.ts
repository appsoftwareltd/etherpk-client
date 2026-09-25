/**
 * Ticking a [[Task]] from the [[Tasks View]] — a write into an authoritative [[Document]],
 * using coordinates the [[Derived Index]] supplied.
 *
 * That tension is the whole reason this module exists. The index is derived and explicitly
 * never authoritative: it can lag the document by a keystroke, and a task's line number is
 * only true for the parse it came from. Writing blind to `line` would mean flipping whatever
 * happens to sit there now — a different task, or a line of prose.
 *
 * So every write is guarded: the line must still parse as a [[Task]] AND still carry the exact
 * text the index recorded. If either fails the write is refused and the caller reveals the
 * task instead, which shows the user reality rather than quietly acting on a stale row. The
 * guard is cheap, and it is the only thing standing between a lagging index and a wrong edit —
 * it must not be "simplified" away.
 */

import { bulletLabel } from './index-derive'
import { frontmatterLineOffset } from './reveal'
import type { DocumentStore } from './types'
import { parseTaskLine } from './task-tags'

/** Where a task sits, as the index reported it. */
export interface IndexedTask {
    /** The document's concept — the store's document id. */
    concept: string
    /** 0-based source line. */
    line: number
    /** The block label as indexed, [[Task Tag]] run included. */
    text: string
}

export type TaskToggleOutcome =
    | { ok: true; done: boolean }
    /** The line moved or changed since it was indexed; nothing was written. */
    | { ok: false; reason: 'stale' }

/** The UTF-16 offset at which `line` starts, or null when the document has no such line. */
function offsetOfLine(lines: readonly string[], line: number): number | null {
    if (line < 0 || line >= lines.length) return null
    let offset = 0
    for (let i = 0; i < line; i++) offset += lines[i].length + 1 // +1 for the newline
    return offset
}

/**
 * Flip one indexed task's checkbox in its document.
 *
 * The edit is a ONE-CHARACTER range replacement over the checkbox itself, never a rewrite of
 * the line: everything else — indentation, marker spacing, the tag run, the text — is left
 * untouched byte for byte, so this cannot reformat what someone wrote, and it is the smallest
 * possible operation to hand a CRDT.
 */
export async function toggleIndexedTask(
    store: DocumentStore,
    task: IndexedTask,
    done: boolean,
): Promise<TaskToggleOutcome> {
    await store.whenReady?.(task.concept)
    const document = store.open(task.concept)
    const text = document.getText()
    const lines = text.split('\n')

    // The index derives over the BODY - frontmatter stripped - so its line numbers are
    // body-relative, while the store hands back the whole file. On a page (which carries
    // frontmatter; a journal and a synced document do not) the two disagree by the fence's
    // height, and without this every tick on a page was refused: line 0 of the file is `---`.
    // The same rule the editor's reveal uses, measured from the text in hand.
    const lineIndex = task.line + frontmatterLineOffset(text)
    const start = offsetOfLine(lines, lineIndex)
    if (start === null) return { ok: false, reason: 'stale' }

    const line = lines[lineIndex]
    const parsed = parseTaskLine(line)
    // Two questions, both necessary: is it still a task at all, and is it still THIS task?
    // The second is what catches a line inserted above, which shifts every line number down
    // while leaving a perfectly valid — and entirely different — task where this one was.
    if (!parsed) return { ok: false, reason: 'stale' }
    const marker = /^(\s*-\s+\[)([ xX])(\])/.exec(line)
    if (!marker) return { ok: false, reason: 'stale' }
    // Compared with the SAME function that produced the indexed label, never a lookalike.
    if (bulletLabel(line) !== task.text) return { ok: false, reason: 'stale' }

    // Already in the requested state: report success without writing, so a double click or a
    // second tab having got there first is not an error the user has to think about.
    if (parsed.done === done) return { ok: true, done }

    const at = start + marker[1].length
    // 'external': this is not the editor typing, so an open editor must be told.
    document.applyChange({ from: at, to: at + 1, insert: done ? 'x' : ' ' }, 'external')
    return { ok: true, done }
}
