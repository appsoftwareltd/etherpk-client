/**
 * Writing a [[Task]]'s status, priority and dates into its [[Document]], and finding the task
 * there first: the one writer a [[Kanban Board]] move and the [[Headless Client]]'s `set_task`
 * share (ADR 0113), and the line finder the [[Tasks View]]'s tick uses too.
 *
 * Every write starts from coordinates the [[Derived Index]] supplied, and the index can lag the
 * document by a second or two. So the task is looked for, never assumed: at its indexed line
 * when that line still holds a task with the same text, otherwise at the one task line in the
 * document with that text. When there is none, or more than one, nothing is written, because a
 * write to a line that merely sits where the task used to be edits the wrong task.
 *
 * A status is exclusive and means what the index's derivation means (`STATUS_SQL`): Open is an
 * unticked task with no state tag, Doing `#D`, Waiting `#W`, Done a ticked one, Cancelled a
 * ticked one with `#C`. No completion date is written; the checkbox writes none either.
 *
 * A write that makes a task Done, or unticks it, ticks or unticks the tasks nested under it in the
 * same document (`task-cascade.ts`), and reports each line it changed so an undo can put it back.
 */
import type { TaskStatus } from './index-db'
import { bulletLabel } from './index-derive'
import { fencedBlocks, linesInFencedBlocks } from './fenced-code'
import { frontmatterLineOffset } from './reveal'
import { lineWriteChanges, type LineWrite, nestedTaskWrites } from './task-cascade'
import { parseTaskLine, parseTaskTags, serialiseTags, type TaskPriority, type TaskTags } from './task-tags'
import type { DocumentStore, EditorDocument } from './types'

/** What to change about a task. Anything left out stays as it is. */
export interface TaskChanges {
    status?: TaskStatus
    priority?: TaskPriority | null
    /** `YYYY-MM-DD`, or null to remove the date. */
    due?: string | null
    scheduled?: string | null
}

/** Where a task sits, as the index reported it. */
export interface IndexedTask {
    /** The document's concept: the store's document id. */
    concept: string
    /** 0-based and body-relative, as the index counts lines. */
    line: number
    /** The block label as indexed, [[Task Tag]] run included. */
    text: string
}

/** One line a write changed: body-relative, and the whole line either side of the write. */
export interface WrittenLine {
    line: number
    before: string
    after: string
}

/**
 * What a write did to a task's document, which is all an undo needs: the task's own line and the
 * nested tasks' lines it brought with it.
 */
export interface TaskWrite extends WrittenLine {
    nested: WrittenLine[]
}

export type TaskWriteOutcome =
    /**
     * `line` is where the task is now (body-relative), `text` its label after the write, and
     * `before` and `after` the whole line either side of it, which is what an undo puts back.
     * `nested` are the nested tasks' lines the write changed with it (`task-cascade.ts`), and
     * `skipped` how many an undo left because they had changed since (0 for any other write).
     */
    | ({ ok: true; text: string; changed: boolean; skipped: number } & TaskWrite)
    /**
     * `stale`: no task line, or more than one, has the task's text. `missing`: the document is
     * gone (renamed or deleted since the index read it). Nothing was written either way.
     */
    | { ok: false; reason: 'stale' | 'missing' }

const MARKER = /^(\s*-\s+\[)[ xX](\])\s?/

/**
 * `line` with `changes` made, or null when `line` is not a task.
 *
 * A changed tag run is written in the fixed order the `#` helper writes (`serialiseTags`), for
 * the reason `applyTaskTag` gives: the run is a set, and a predictable order is worth more than
 * one that carries no meaning. A task already as asked comes back untouched, so a move that
 * changes nothing reorders nothing either.
 */
export function taskLineWith(line: string, changes: TaskChanges): string | null {
    const parsed = parseTaskLine(line)
    const marker = MARKER.exec(line)
    if (!parsed || !marker) return null
    const { done: wasDone, ...current } = parsed
    const tags: TaskTags = { ...current }
    let done = wasDone
    switch (changes.status) {
        case 'open':
            done = false
            tags.waiting = tags.doing = tags.cancelled = false
            break
        case 'doing':
            done = false
            tags.doing = true
            tags.waiting = tags.cancelled = false
            break
        case 'waiting':
            done = false
            tags.waiting = true
            tags.doing = tags.cancelled = false
            break
        case 'done':
            done = true
            tags.waiting = tags.doing = tags.cancelled = false
            break
        case 'cancelled':
            done = true
            tags.cancelled = true
            tags.waiting = tags.doing = false
            break
        case undefined:
            break
    }
    if (changes.priority !== undefined) tags.priority = changes.priority
    if (changes.due !== undefined) tags.due = changes.due
    if (changes.scheduled !== undefined) tags.scheduled = changes.scheduled
    if (done === wasDone && sameTags(tags, current)) return line
    // One space between the checkbox, each tag and the text, and none at the end when a task has
    // tags but no text: the way the `#` helper writes a run.
    return [`${marker[1]}${done ? 'x' : ' '}${marker[2]}`, ...serialiseTags(tags), tags.text].filter((part) => part !== '').join(' ')
}

function sameTags(a: TaskTags, b: TaskTags): boolean {
    return (
        a.priority === b.priority &&
        a.waiting === b.waiting &&
        a.doing === b.doing &&
        a.cancelled === b.cancelled &&
        a.due === b.due &&
        a.scheduled === b.scheduled &&
        a.completion === b.completion
    )
}

/** A task's text with its tag run taken off: what identifies it while its tags change. */
function taskText(label: string): string {
    return parseTaskTags(label).text.trim()
}

/** The indexes of the lines inside fenced code, whose task-shaped lines are not tasks. */
function linesInFences(lines: readonly string[]): Set<number> {
    return linesInFencedBlocks(fencedBlocks(lines))
}

/**
 * Whether body line `line` of `text` (0-based, as the index counts lines) holds a task as the index
 * reads one: a task line, outside fenced code.
 */
export function isTaskLine(text: string, line: number): boolean {
    if (line < 0) return false
    const lines = text.split('\n')
    const index = frontmatterLineOffset(text) + line
    return index < lines.length && !linesInFences(lines).has(index) && parseTaskLine(lines[index]) !== null
}

/**
 * The index of the line holding the task whose indexed label is `label`, among `lines` from
 * `from` on (the body, past any frontmatter), or null.
 *
 * The indexed line wins when it still holds a task with the same text; its tag run may differ,
 * since a move rewrites exactly that. Otherwise the one task line with that text anywhere in the
 * body, never a line inside a code fence, which is not a task. None, or more than one, is null:
 * the caller cannot know which task was meant.
 */
export function locateTask(lines: readonly string[], index: number, label: string, from = 0): number | null {
    const wanted = taskText(label)
    const inFence = linesInFences(lines)
    const holds = (i: number) => !inFence.has(i) && parseTaskLine(lines[i]) !== null && taskText(bulletLabel(lines[i])) === wanted
    if (index >= from && index < lines.length && holds(index)) return index
    let found: number | null = null
    for (let i = from; i < lines.length; i++) {
        if (!holds(i)) continue
        if (found !== null) return null
        found = i
    }
    return found
}

/** A task found in its document: the handle, and the line in the whole text. */
export interface FoundTask {
    document: EditorDocument
    lines: string[]
    /** Index into `lines`, which include any frontmatter. */
    index: number
    /** How many lines of frontmatter precede the body. */
    bodyStart: number
    /** The UTF-16 offset at which the task's line starts. */
    offset: number
}

/**
 * Open the task's document and find the task in it, or say why not. A document that cannot be
 * opened (renamed or deleted since the index read it, or not synced into a readable state) is
 * `missing`; it is reported, never thrown, so a caller can say so instead of failing silently.
 */
export async function findIndexedTask(store: DocumentStore, task: IndexedTask): Promise<FoundTask | { reason: 'stale' | 'missing' }> {
    let document: EditorDocument
    try {
        await store.whenReady?.(task.concept)
        document = store.open(task.concept)
    } catch {
        // A `DocumentNotFoundError` (renamed or deleted since the index read it), or a synced
        // document that cannot be read now: either way there is no task here to write to.
        return { reason: 'missing' }
    }
    const text = document.getText()
    const lines = text.split('\n')
    // The index derives over the body, frontmatter stripped, so its lines are body-relative
    // while the store hands back the whole file.
    const bodyStart = frontmatterLineOffset(text)
    const index = locateTask(lines, task.line + bodyStart, task.text, bodyStart)
    if (index === null) return { reason: 'stale' }
    let offset = 0
    for (let i = 0; i < index; i++) offset += lines[i].length + 1
    return { document, lines, index, bodyStart, offset }
}

/**
 * Make `changes` to the indexed task in its document, as the smallest single edit.
 *
 * The edit is `external`, since it is not the editor typing: an open editor must be told. And
 * it is the minimal replacement over the line, not the whole line, so on a synced graph it
 * merges with anyone typing elsewhere in the same line.
 */
export async function writeTaskChanges(store: DocumentStore, task: IndexedTask, changes: TaskChanges): Promise<TaskWriteOutcome> {
    const found = await findIndexedTask(store, task)
    if ('reason' in found) return { ok: false, reason: found.reason }
    const next = taskLineWith(found.lines[found.index], changes)
    if (next === null) return { ok: false, reason: 'stale' }
    return writeFoundTask(found, next)
}

/**
 * Undo `write`: put back each line it changed, the task's own and its nested tasks', in the task's
 * document `concept`. The outcome is itself a write, so a redo is the undo of the undo's outcome.
 *
 * The task's line is the anchor. It is found as any write finds it, by its indexed line or its
 * text, and nothing is written when it reads anything but what the write left, because an undo
 * that overwrote an edit made since would lose that edit. Each nested line is looked for where the
 * task's move puts it (lines added above the task move them all alike) and put back only while it
 * still reads what the write left; any other is left as it is and counted in `skipped`.
 */
export async function undoTaskWrite(store: DocumentStore, concept: string, write: TaskWrite): Promise<TaskWriteOutcome> {
    const found = await findIndexedTask(store, { concept, line: write.line, text: bulletLabel(write.after) })
    if ('reason' in found) return { ok: false, reason: found.reason }
    if (found.lines[found.index] !== write.after) return { ok: false, reason: 'stale' }
    const shift = found.index - found.bodyStart - write.line
    const nested: LineWrite[] = []
    let skipped = 0
    for (const line of write.nested) {
        const index = found.bodyStart + line.line + shift
        if (found.lines[index] === line.after) nested.push({ index, before: line.after, after: line.before })
        else skipped++
    }
    return { ...applyWrites(found, write.before, nested), skipped }
}

/**
 * Write `next` over the found task's line, with the nested tasks' lines that brings with it, each
 * as the smallest single edit. The Tasks View's tick writes through here too.
 */
export function writeFoundTask(found: FoundTask, next: string): TaskWriteOutcome {
    return { ...applyWrites(found, next, nestedTaskWrites(found.lines, found.index, next)), skipped: 0 }
}

/**
 * Make the task's line `next` and make `nested` (indexes into `found.lines`), as edits that are
 * `external`, since this is not the editor typing: an open editor must be told. Each is the
 * minimal replacement within its line, not the whole line, so on a synced graph it merges with
 * anyone typing elsewhere in the same line. They are applied last line first, so each lands above
 * every edit already made and the offsets read from `found` stay true.
 */
function applyWrites(found: FoundTask, next: string, nested: LineWrite[]): Omit<Extract<TaskWriteOutcome, { ok: true }>, 'skipped'> {
    const current = found.lines[found.index]
    const own: LineWrite = { index: found.index, before: current, after: next }
    for (const change of lineWriteChanges(found.lines, [own, ...nested])) found.document.applyChange(change, 'external')
    return {
        ok: true,
        line: found.index - found.bodyStart,
        text: bulletLabel(next),
        changed: next !== current || nested.length > 0,
        before: current,
        after: next,
        nested: nested.map(({ index, before, after }) => ({ line: index - found.bodyStart, before, after })),
    }
}
