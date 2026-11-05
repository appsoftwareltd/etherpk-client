/**
 * Pure logic for the `#` [[Task Tag]] helper: detecting the `#` the cursor sits behind, and
 * filtering the offerable tag actions and [[Free Tag]]s against what has been typed. CodeMirror-free so it is
 * unit-testable; the CM wiring (task-line gating, the popover, the calendar) lives in
 * `task-tag-complete.ts`.
 */

import { freeTagsIn, isTaskTagShaped, type TaskPriority } from '../../task-tags'
import { matchScore } from './wikilink-complete-core'

/** The `#`-triggered context the cursor sits in, as columns within a line. */
export interface TaskTagContext {
    /** Column of the triggering `#`. */
    hash: number
    /** Text typed after the `#` so far (never contains whitespace). */
    query: string
}

/**
 * The helper's context for `linePrefix` (the line's text up to the cursor) and `lineRest` (the text
 * after it), or null when the cursor is not behind a word-boundary `#`.
 *
 * Word-boundary like the `/` menu: the token ending at the cursor must *start* with `#`, so
 * `C#`, `issue#42` and a mid-word `#` never trigger. A second `#` (`##`) does not either —
 * that is a heading being typed.
 *
 * A row takes the typed `#query` off the line, which is only what is before the cursor, so the
 * cursor must be at the end of the token: from inside `#P|2`, a row would leave the rest of the tag
 * behind as a word of its own (`#P1 2`). The one token it may be inside is a bare `#` typed in front
 * of a word, which is how a tag is added ahead of a task's words, unless that word makes the `#` a
 * Task Tag's.
 */
export function openTaskTagContext(linePrefix: string, lineRest = ''): TaskTagContext | null {
    let i = linePrefix.length
    while (i > 0 && !/\s/.test(linePrefix[i - 1])) i--
    const token = linePrefix.slice(i)
    if (!token.startsWith('#') || token.startsWith('##')) return null
    const rest = /^\S*/.exec(lineRest)![0]
    if (rest !== '' && (token !== '#' || isTaskTagShaped(rest))) return null
    return { hash: i, query: token.slice(1) }
}

/** What choosing a row does. Dates defer to the calendar; the rest apply immediately. */
export type TaskTagAction =
    | { kind: 'priority'; value: TaskPriority }
    | { kind: 'waiting' }
    | { kind: 'doing' }
    | { kind: 'test' }
    | { kind: 'cancelled' }
    | { kind: 'archived' }
    | { kind: 'date'; tag: 'due' | 'scheduled' | 'completion' }
    | { kind: 'free-tag'; tag: string }

export interface TaskTagItem {
    label: string
    /** The tag as it will be written, shown as the row's hint. */
    detail: string
    /** Extra terms the query can match, so "critical" finds P1. */
    keywords: string[]
    action: TaskTagAction
}

/**
 * Every action the helper can offer, in menu order: priorities, then the state flags, then
 * the dates. Ordered by how often they are reached for, not alphabetically — a bare `#`
 * lists all of them, and the first row should be the common one.
 *
 * A state and a date can share a letter (`#D` doing / `#D-` due, `#C` cancelled / `#C-`
 * completion). Both rows carry the bare letter as a keyword, so `#D` ties them and menu order
 * puts the state first — Enter then writes the tag just typed — while `#D-` matches only the
 * date, exactly as the grammar reads them.
 */
export const TASK_TAG_ITEMS: readonly TaskTagItem[] = [
    { label: 'Priority 1', detail: '#P1', keywords: ['p1', 'critical', 'high'], action: { kind: 'priority', value: 1 } },
    { label: 'Priority 2', detail: '#P2', keywords: ['p2', 'medium'], action: { kind: 'priority', value: 2 } },
    { label: 'Priority 3', detail: '#P3', keywords: ['p3', 'low', 'normal'], action: { kind: 'priority', value: 3 } },
    { label: 'Waiting', detail: '#W', keywords: ['w', 'blocked', 'someone'], action: { kind: 'waiting' } },
    { label: 'Doing', detail: '#D', keywords: ['d', 'progress', 'started'], action: { kind: 'doing' } },
    { label: 'Test', detail: '#T', keywords: ['t', 'testing', 'check', 'verify'], action: { kind: 'test' } },
    { label: 'Cancelled', detail: '#C', keywords: ['c', 'dropped', 'abandoned'], action: { kind: 'cancelled' } },
    { label: 'Archived', detail: '#A', keywords: ['a', 'archive', 'put away'], action: { kind: 'archived' } },
    { label: 'Due date…', detail: '#D-', keywords: ['d', 'deadline', 'by'], action: { kind: 'date', tag: 'due' } },
    { label: 'Scheduled date…', detail: '#S-', keywords: ['s', 'start'], action: { kind: 'date', tag: 'scheduled' } },
    {
        label: 'Completion date…',
        detail: '#C-',
        keywords: ['c', 'completed', 'finished'],
        action: { kind: 'date', tag: 'completion' },
    },
]

/**
 * The items matching `query`, best first. An empty query lists everything in menu order, so a
 * bare `#` is a discovery surface. Reuses the shared `matchScore` (exact › prefix › substring
 * › subsequence) over the label, the tag itself and the keywords — so `#P1`, `#p`, `#crit`
 * and `#1` all reach Priority 1.
 */
export function rankTaskTagItems(query: string, items: readonly TaskTagItem[] = TASK_TAG_ITEMS): TaskTagItem[] {
    if (query === '') return [...items]
    const scored: { item: TaskTagItem; score: number; order: number }[] = []
    items.forEach((item, order) => {
        let best: number | null = null
        for (const term of [item.label, item.detail, ...item.keywords]) {
            const score = matchScore(term, query)
            if (score !== null && (best === null || score > best)) best = score
        }
        if (best !== null) scored.push({ item, score: best, order })
    })
    scored.sort((a, b) => b.score - a.score || a.order - b.order)
    return scored.map((s) => s.item)
}

/** Free Tag rows the menu shows at most: a graph can use hundreds, and typing narrows them. */
const MAX_FREE_TAG_ROWS = 12

function freeTagItem(tag: string): TaskTagItem {
    return { label: tag, detail: `#${tag}`, keywords: [], action: { kind: 'free-tag', tag } }
}

/** The rows for a typed `#query`, and which one starts highlighted, or -1 for none. */
export interface TaskTagMenu {
    items: TaskTagItem[]
    selected: number
}

/**
 * The helper's rows for `query`: the Task Tag rows {@link rankTaskTagItems} gives, then the [[Free
 * Tag]]s of `used` (most used first, as the index gives them) that hold the typed letters in a row.
 * Those starting with the letters come first. A bare `#` lists only the Task Tags. `line` is the
 * task's line without the `#query`, and a tag it already has is not offered again.
 *
 * A word that is already a whole Free Tag has no row of its own, because picking it would change
 * nothing, and nothing starts highlighted. A tag often sits last on a line, and an open menu takes
 * Enter, so otherwise the caret arriving behind `#call` would turn Enter into Cancelled, whose
 * letters `call` also matches, or `#bug` into `#bugfix`. The rows are still there for the arrow keys.
 */
export function taskTagMenu(query: string, used: readonly string[], line: string): TaskTagMenu {
    const known = rankTaskTagItems(query)
    if (query === '') return { items: known, selected: 0 }

    const typed = query.toLowerCase()
    const onLine = new Set(freeTagsIn(line).map((tag) => tag.toLowerCase()))
    const holding = used.filter((tag) => {
        const key = tag.toLowerCase()
        return key !== typed && key.includes(typed) && !onLine.has(key)
    })
    // A stable sort, so each group keeps the index's most used first.
    const startingWith = (tag: string) => tag.toLowerCase().startsWith(typed)
    const offered = holding.sort((a, b) => Number(startingWith(b)) - Number(startingWith(a))).slice(0, MAX_FREE_TAG_ROWS)
    return {
        items: [...known, ...offered.map(freeTagItem)],
        selected: used.some((tag) => tag.toLowerCase() === typed) ? -1 : 0,
    }
}
