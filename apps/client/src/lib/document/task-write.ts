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
 */
import type { TaskStatus } from './index-db'
import { bulletLabel } from './index-derive'
import { fencedBlocks } from './fenced-code'
import { frontmatterLineOffset } from './reveal'
import { parseTaskLine, parseTaskTags, serialiseTags, type TaskPriority, type TaskTags } from './task-tags'
import type { DocumentStore, EditorDocument } from './types'
import { minimalReplacement } from './view/minimal-replacement'

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

export type TaskWriteOutcome =
    /**
     * `line` is where the task is now (body-relative), `text` its label after the write, and
     * `before` and `after` the whole line either side of it, which is what an undo puts back.
     */
    | { ok: true; line: number; text: string; changed: boolean; before: string; after: string }
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
    const inFence = new Set<number>()
    for (const block of fencedBlocks(lines)) for (let i = block.start; i <= block.end; i++) inFence.add(i)
    return inFence
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
    const current = found.lines[found.index]
    const next = taskLineWith(current, changes)
    if (next === null) return { ok: false, reason: 'stale' }
    return replaceLine(found, current, next)
}

/**
 * Put back the line a move replaced: `next`, where the task's line reads exactly `expected`,
 * the line the move wrote. The task is found as any write finds it, by its indexed line or its
 * text, and nothing is written when its line reads anything else, because an undo that
 * overwrote an edit made since the move would lose that edit.
 */
export async function restoreTaskLine(store: DocumentStore, task: IndexedTask, expected: string, next: string): Promise<TaskWriteOutcome> {
    const found = await findIndexedTask(store, task)
    if ('reason' in found) return { ok: false, reason: found.reason }
    const current = found.lines[found.index]
    if (current !== expected) return { ok: false, reason: 'stale' }
    return replaceLine(found, current, next)
}

/** Write `next` over the found task's line, `current`, as the smallest single edit. */
function replaceLine(found: FoundTask, current: string, next: string): TaskWriteOutcome {
    const line = found.index - found.bodyStart
    const text = bulletLabel(next)
    const edit = minimalReplacement(current, next)
    if (edit === null) return { ok: true, line, text, changed: false, before: current, after: next }
    found.document.applyChange({ from: found.offset + edit.from, to: found.offset + edit.to, insert: edit.insert }, 'external')
    return { ok: true, line, text, changed: true, before: current, after: next }
}
