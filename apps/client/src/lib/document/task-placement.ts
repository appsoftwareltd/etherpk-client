/**
 * Where a [[Task]] made in the [[Task Editor]] is written (ADR 0170): today's [[Journal Entry]],
 * under the entry's bullet linking the [[Kanban Board]]'s [[Concept]], so the task answers to that
 * concept by [[Task Concept]] and shows on the board it was made from.
 *
 * - An entry with a top-level bullet holding nothing but a link to the concept (by any of its names,
 *   in any case, as [[Backlink]]s pool them) gets the task as that bullet's last child.
 * - Otherwise the entry gets a new `- [[Concept]]` bullet at its end, the task under it, after one
 *   blank line, as [[Quick Notes]] are moved into an entry (`quick-notes-journal.ts`).
 * - On the Graph Kanban, which has no concept, the task is a top-level bullet of its own.
 *
 * `taskPlacement` is pure; `addTaskToJournal` writes it, creating the day's entry when there is none.
 */
import { canCreateDocuments, type DocumentCreatingStore, whenDocumentText } from './draft'
import { fencedBlocks, linesInFencedBlocks } from './fenced-code'
import { INDENT } from './indent-unit'
import { branchRange, bulletContent, isBulletLine, lineIndent } from './outliner'
import { journalSeparator } from './quick-notes-journal'
import { frontmatterLineOffset } from './reveal'
import type { DocumentStore, TextChange } from './types'

/** A bullet's words that are one wikilink and nothing else: `[[Garden]]`. */
const LINK_ALONE = /^\[\[([^[\]|]+)\]\]$/

/** The change that writes the task, the task line's place in the body once written (0-based), and that line. */
export interface TaskPlacement extends TextChange {
    line: number
    text: string
}

/**
 * The change that writes `lines` (a task and its description, at the left margin) into the entry
 * `text`, under the bullet linking `concept`, or at the top level when `concept` is null.
 * `sameConcept` says whether a linked name is the concept: the caller pools names as the index does.
 */
export function taskPlacement(text: string, concept: string | null, sameConcept: (name: string) => boolean, lines: readonly string[]): TaskPlacement {
    const all = text.split('\n')
    const bodyStart = frontmatterLineOffset(text)
    const parent = concept === null ? null : conceptBullet(all, bodyStart, sameConcept)
    if (parent !== null) {
        const last = branchRange(all, parent).end
        const at = all.slice(0, last + 1).reduce((offset, line) => offset + line.length + 1, 0) - 1
        const insert = `\n${lines.map((line) => INDENT + line).join('\n')}`
        return { from: at, to: at, insert, line: last + 1 - bodyStart, text: INDENT + lines[0] }
    }
    const block = concept === null ? [...lines] : [`- [[${concept}]]`, ...lines.map((line) => INDENT + line)]
    const separator = journalSeparator(text)
    // The block's first line starts after the text and its separator; the task is the block's
    // first line, or its second, under the concept's bullet.
    const before = (text + separator).split('\n').length - 1
    return {
        from: text.length,
        to: text.length,
        insert: `${separator}${block.join('\n')}\n`,
        line: before + (concept === null ? 0 : 1) - bodyStart,
        text: concept === null ? lines[0] : INDENT + lines[0],
    }
}

/** The first top-level bullet in the body holding only a link to the concept, or null. */
function conceptBullet(lines: readonly string[], bodyStart: number, sameConcept: (name: string) => boolean): number | null {
    const inFence = linesInFencedBlocks(fencedBlocks(lines))
    for (let i = bodyStart; i < lines.length; i++) {
        const line = lines[i]
        if (inFence.has(i) || lineIndent(line) !== 0 || !isBulletLine(line)) continue
        const link = LINK_ALONE.exec(bulletContent(line).trim())
        if (link && sameConcept(link[1].trim())) return i
    }
    return null
}

export interface NewJournalTask {
    /** The day's [[Journal Concept]]: today's, read by the caller as it writes. */
    day: string
    concept: string | null
    sameConcept: (name: string) => boolean
    /** The task and its description at the left margin (`newTaskLines`). */
    lines: readonly string[]
}

/** Where the task was written: its document, its line in the body (0-based), and the line as written. */
export interface AddedTask {
    document: string
    line: number
    text: string
}

/**
 * Write the task into the day's entry: the entry is created holding it when there is none, and
 * otherwise the task is written into it as one `external` change, so an editor open on the entry
 * shows it land. Create-or-adopt as Quick Notes do: a create refused because the entry exists (a peer,
 * another tab) falls through to the write.
 */
export async function addTaskToJournal(store: DocumentStore, task: NewJournalTask): Promise<AddedTask> {
    if (!canCreateDocuments(store)) throw new Error('This graph cannot create a journal entry.')
    const written = (placement: TaskPlacement): AddedTask => ({ document: task.day, line: placement.line, text: placement.text })
    const fresh = taskPlacement('', task.concept, task.sameConcept, task.lines)
    if (await created(store, task.day, fresh.insert)) return written(fresh)
    const document = store.open(task.day)
    const existing = await whenDocumentText(store, document, task.day)
    const placement = taskPlacement(existing, task.concept, task.sameConcept, task.lines)
    document.applyChange({ from: placement.from, to: placement.to, insert: placement.insert }, 'external')
    return written(placement)
}

/** Create the entry holding `body`, or false when the store refuses (the entry exists already). */
async function created(store: DocumentCreatingStore, day: string, body: string): Promise<boolean> {
    try {
        await store.createJournal(day, body)
        return true
    } catch {
        return false
    }
}
