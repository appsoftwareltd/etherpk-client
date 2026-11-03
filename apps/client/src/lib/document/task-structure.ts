/**
 * The common task structure the [[Task Editor]] edits (ADR 0170), read from a [[Task]]'s lines and
 * written back as text.
 *
 * A task is its line and the [[Block]]s nested under it, and the structure is only a way of reading
 * them:
 *
 * - **Title**: the task's words, without its [[Task Tag]] run and its [[Free Tag]]s.
 * - **Lane, priority, due and scheduled dates and Free Tags**: read from the line by the task grammar
 *   (`task-tags.ts`).
 * - **Assets**: every asset reference the task line and the lines nested under it show, fenced code
 *   left out. One list for the Task Editor and the Headless Client's `read_task`.
 * - **Comments**: the children of the first bullet nested directly under the task whose words are
 *   exactly `Comments`. Each child is one [[Task Comment]].
 * - **Description**: every child above the Comments bullet, or every child when there is none:
 *   notes, images, nested tasks.
 * - **Additional context**: every child below the Comments block, written there by typing in the
 *   document or by an agent. The split is by position only, so every line nested under the task is
 *   in exactly one part, nothing in the text is ever lost to the structure, and the markdown stays
 *   the truth an agent reads.
 *
 * Pure and DOM-free: the Client's Task Editor and the [[Headless Client]]'s `add_task_note` both
 * read and write through it, so a comment an agent adds lands where the editor shows it.
 */
import { fencedBlocks, type FencedBlockRange, linesInFencedBlocks } from './fenced-code'
import { INDENT } from './indent-unit'
import { branchRange, bulletContent, isBulletLine, lineIndent, taskDone } from './outliner'
import { freeTagsIn, isTaskDate, parseTaskLine, parseTaskTags, serialiseTags, type TaskPriority, taskLineWith, taskStatus, type TaskStatus, withoutFreeTags } from './task-tags'
import type { TextChange } from './types'

/** The words of the bullet that holds a task's [[Task Comment]]s. */
export const TASK_COMMENTS = 'Comments'

/** A run of lines by index, `to` exclusive: empty when `from === to`. */
export interface LineSpan {
    from: number
    to: number
}

export interface TaskStructure {
    /** The task line's index. */
    line: number
    /** The indent of a line nested directly under the task. */
    childIndent: string
    title: string
    status: TaskStatus
    priority: TaskPriority | null
    /** The task's Free Tags, without their `#`, as written. */
    freeTags: string[]
    /** The due date its `#D-YYYY-MM-DD` tag gives, or null. */
    due: string | null
    /** The scheduled date its `#S-YYYY-MM-DD` tag gives, or null. */
    scheduled: string | null
    /** The lines nested under the task before its Comments bullet, or all of them when it has none. */
    description: LineSpan
    /** The Comments bullet's line, or null when the task has none. */
    commentsLine: number | null
    /** The lines nested under the Comments bullet, or null when the task has none. */
    comments: LineSpan | null
    /**
     * The lines nested under the task after its Comments block, or null when there are none (the
     * Comments block is the task's last child, or the task has no Comments bullet).
     */
    additionalContext: LineSpan | null
    /** The line after the task's last nested line. */
    end: number
    /**
     * The [[Asset]]s the task line and every line nested under it show (its description, its
     * comments and its additional context), once each, in the order written. A reference in fenced
     * code is text the code shows, not an asset, and is left out.
     */
    assets: string[]
}

/** Every asset reference in a body: `../assets/<name>` at any depth, as markdown or HTML writes it. */
const ASSET_REFS = /(?:\.\.\/)+assets\/[^\s)"'<>\]]+/g

/** Each asset reference in `body`, as often as it is written. */
export function assetReferencesIn(body: string): string[] {
    return [...body.matchAll(ASSET_REFS)].map((match) => match[0])
}

/** A task's title: its words, without the tag run or the Free Tags. */
export function taskTitle(label: string): string {
    return withoutFreeTags(parseTaskTags(label).text)
}

/**
 * The structure of the task on line `index`, or null when that line holds no task (or sits in fenced
 * code, where a task-shaped line is code).
 */
export function readTaskStructure(lines: readonly string[], index: number, blocks: readonly FencedBlockRange[] = fencedBlocks(lines)): TaskStructure | null {
    const inFence = linesInFencedBlocks(blocks)
    const parsed = index >= 0 && index < lines.length && !inFence.has(index) ? parseTaskLine(lines[index]) : null
    if (!parsed) return null
    const end = branchEnd(lines, index, blocks)
    const commentsLine = commentsBulletOf(lines, index, end, inFence, blocks)
    const comments = commentsLine === null ? null : { from: commentsLine + 1, to: branchEnd(lines, commentsLine, blocks) }
    const description = { from: index + 1, to: commentsLine ?? end }
    const additionalContext = comments !== null && comments.to < end ? { from: comments.to, to: end } : null
    return {
        line: index,
        childIndent: ' '.repeat(lineIndent(lines[index])) + INDENT,
        title: withoutFreeTags(parsed.text),
        status: taskStatus(parsed.done, parsed),
        priority: parsed.priority,
        freeTags: freeTagsIn(parsed.text),
        due: parsed.due,
        scheduled: parsed.scheduled,
        description,
        commentsLine,
        comments,
        additionalContext,
        end,
        assets: assetsShown(lines, { from: index, to: end }, inFence),
    }
}

/** The line after the branch rooted at line `index`. */
function branchEnd(lines: readonly string[], index: number, blocks: readonly FencedBlockRange[]): number {
    return branchRange(lines as string[], index, blocks as FencedBlockRange[]).end + 1
}

/** The assets the span's lines show, once each, leaving out the lines in fenced code. */
function assetsShown(lines: readonly string[], span: LineSpan, inFence: Set<number>): string[] {
    const shown = lines.slice(span.from, span.to).filter((_, offset) => !inFence.has(span.from + offset))
    return [...new Set(assetReferencesIn(shown.join('\n')))]
}

/**
 * The first bullet nested directly under the task whose words are exactly `Comments`, or null. A
 * direct child is a bullet that no earlier child's branch holds; a task line is never one.
 */
function commentsBulletOf(lines: readonly string[], task: number, end: number, inFence: Set<number>, blocks: readonly FencedBlockRange[]): number | null {
    let at = task + 1
    while (at < end) {
        const line = lines[at]
        if (inFence.has(at) || !isBulletLine(line)) {
            at++
            continue
        }
        if (taskDone(line) === undefined && bulletContent(line).trim() === TASK_COMMENTS) return at
        at = branchEnd(lines, at, blocks)
    }
    return null
}

/**
 * The task's [[Task Comment]]s as text: each comment's words, with the lines nested under it moved to
 * the left margin as they are relative to it. Lines under the Comments bullet that are no bullet of
 * their own continue the comment before them.
 */
export function taskComments(lines: readonly string[], task: TaskStructure): string[] {
    if (!task.comments) return []
    const margin = task.childIndent.length + INDENT.length
    const comments: string[][] = []
    for (const line of lines.slice(task.comments.from, task.comments.to)) {
        const own = lineIndent(line) === margin && isBulletLine(line)
        if (own || comments.length === 0) comments.push([])
        comments[comments.length - 1].push(line.slice(Math.min(margin, lineIndent(line))))
    }
    return comments.map((comment) => comment.join('\n').replace(/^-\s+/, ''))
}

/** The task line's checkbox and what is after it, or null when the line is not a task. */
const CHECKBOX = /^(\s*-\s+\[[ xX]\])\s?(.*)$/

/**
 * `line` with its title made `title`: the tag run written as the task grammar writes it, then the
 * title, then the Free Tags, wherever they were written before. A title already as asked leaves the
 * line alone, so Free Tags written among the words stay there. Null when the line is not a task.
 */
export function taskLineWithTitle(line: string, title: string): string | null {
    const marker = CHECKBOX.exec(line)
    if (!marker) return null
    const tags = parseTaskTags(marker[2])
    if (withoutFreeTags(tags.text) === title.trim()) return line
    const freeTags = freeTagsIn(tags.text).map((tag) => `#${tag}`)
    return [marker[1], ...serialiseTags(tags), title.trim(), ...freeTags].filter((part) => part !== '').join(' ')
}

/**
 * `line` with the Free Tag `tag` (no `#`) added at its end, or taken out wherever it is written,
 * matched ignoring case. Adding a tag the line has already leaves it alone. Null when not a task.
 */
export function taskLineWithFreeTag(line: string, tag: string, present: boolean): string | null {
    const marker = CHECKBOX.exec(line)
    if (!marker) return null
    const key = tag.toLowerCase()
    const label = marker[2]
    if (present) {
        if (freeTagsIn(label).some((written) => written.toLowerCase() === key)) return line
        return `${line.trimEnd()} #${tag}`
    }
    const kept = withoutFreeTags(label, (word) => word.toLowerCase() === key)
    return kept === label ? line : [marker[1], kept].filter((part) => part !== '').join(' ')
}

/** What a new task is made of: the Task Editor's fields. */
export interface NewTask {
    status: TaskStatus
    priority: TaskPriority | null
    title: string
    freeTags: readonly string[]
    /** `YYYY-MM-DD`, written as `#D-YYYY-MM-DD`; absent or null for none. */
    due?: string | null
    /** `YYYY-MM-DD`, written as `#S-YYYY-MM-DD`; absent or null for none. */
    scheduled?: string | null
}

/** A line with nothing to say: blank, or a bare bullet marker. */
const EMPTY_LINE = /^\s*(?:-\s*)?$/

/**
 * A new task's lines at the left margin: its line, with the tag run the task grammar writes for its
 * status, priority and dates, then its title and Free Tags; then `description`, written at the left margin,
 * nested one level under it. Blank lines are dropped (a flush blank line would end the task's
 * branch), and so are bare bullets at the description's end, where an untouched one is left over.
 */
export function newTaskLines(task: NewTask, description: string): string[] {
    // A date that is no whole `YYYY-MM-DD` is written as none: the grammar would read it as words.
    const date = (value: string | null | undefined) => (value && isTaskDate(value) ? value : null)
    const checkbox = taskLineWith('- [ ] ', { status: task.status, priority: task.priority, due: date(task.due), scheduled: date(task.scheduled) })!.trimEnd()
    const line = [checkbox, task.title.trim(), ...task.freeTags.map((tag) => `#${tag}`)].filter((part) => part !== '').join(' ')
    const nested = description.split('\n').filter((text) => text.trim() !== '')
    while (nested.length > 0 && EMPTY_LINE.test(nested[nested.length - 1])) nested.pop()
    return [line, ...nested.map((text) => INDENT + text)]
}

/**
 * Text written as a [[Task Comment]]: a bullet whose later lines continue it, or bullets as they
 * are written. The result sits at the left margin, ready to be nested.
 */
export function asCommentBullet(text: string): string {
    const written = text.trim()
    return written.startsWith('- ') ? written : `- ${written.replace(/\n/g, `\n${INDENT}`)}`
}

/** The UTF-16 offset of the end of line `index`. */
function lineEndOffset(lines: readonly string[], index: number): number {
    let offset = 0
    for (let i = 0; i <= index; i++) offset += lines[i].length + 1
    return offset - 1
}

/**
 * The change that adds `note` (bullets at the left margin, as {@link asCommentBullet} writes them) as
 * the last [[Task Comment]] of the task on line `index` of `text`: at the end of its Comments block,
 * above any additional context after it, or under a Comments bullet started as the task's last child
 * when it has none. `line` is the note's first line once
 * written. Null when the line holds no task.
 */
export function commentChange(text: string, index: number, note: string): (TextChange & { line: number }) | null {
    const lines = text.split('\n')
    const task = readTaskStructure(lines, index)
    if (!task) return null
    const commentIndent = task.childIndent + INDENT
    const nested = note.split('\n').map((noteLine) => (noteLine === '' ? noteLine : commentIndent + noteLine))
    const after = task.comments ? task.comments.to - 1 : task.end - 1
    const added = task.comments ? nested : [`${task.childIndent}- ${TASK_COMMENTS}`, ...nested]
    const at = lineEndOffset(lines, after)
    return { from: at, to: at, insert: `\n${added.join('\n')}`, line: after + 1 + (task.comments ? 0 : 1) }
}

/**
 * The change that takes the task on line `index` out of `text`, with everything nested under it and
 * one line break, and the text it removes, which put back at `from` restores it. Null when the line
 * holds no task.
 */
export function taskRemoval(text: string, index: number): (TextChange & { removed: string }) | null {
    const lines = text.split('\n')
    if (!readTaskStructure(lines, index)) return null
    const last = branchRange(lines, index).end
    const start = index === 0 ? 0 : lineEndOffset(lines, index - 1) + 1
    // The break before the task goes with it, or, for a task on the first line, the break after it.
    const from = index === 0 ? 0 : start - 1
    const to = index === 0 && last + 1 < lines.length ? lineEndOffset(lines, last) + 1 : lineEndOffset(lines, last)
    return { from, to, insert: '', removed: text.slice(from, to) }
}
