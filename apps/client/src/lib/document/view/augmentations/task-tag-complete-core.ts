/**
 * Pure logic for the `#` [[Task Tag]] helper: detecting the `#` the cursor sits behind, and
 * filtering the offerable tag actions against what has been typed. CodeMirror-free so it is
 * unit-testable; the CM wiring (task-line gating, the popover, the calendar) lives in
 * `task-tag-complete.ts`.
 */

import type { TaskPriority } from '../../task-tags'
import { matchScore } from './wikilink-complete-core'

/** The `#`-triggered context the cursor sits in, as columns within a line. */
export interface TaskTagContext {
    /** Column of the triggering `#`. */
    hash: number
    /** Text typed after the `#` so far (never contains whitespace). */
    query: string
}

/**
 * The helper's context for `linePrefix` (the line's text up to the cursor), or null when the
 * cursor is not behind a word-boundary `#`.
 *
 * Word-boundary like the `/` menu: the token ending at the cursor must *start* with `#`, so
 * `C#`, `issue#42` and a mid-word `#` never trigger. A second `#` (`##`) does not either —
 * that is a heading being typed.
 */
export function openTaskTagContext(linePrefix: string): TaskTagContext | null {
    let i = linePrefix.length
    while (i > 0 && !/\s/.test(linePrefix[i - 1])) i--
    const token = linePrefix.slice(i)
    if (!token.startsWith('#') || token.startsWith('##')) return null
    return { hash: i, query: token.slice(1) }
}

/** What choosing a row does. Dates defer to the calendar; the rest apply immediately. */
export type TaskTagAction =
    | { kind: 'priority'; value: TaskPriority }
    | { kind: 'waiting' }
    | { kind: 'doing' }
    | { kind: 'cancelled' }
    | { kind: 'date'; tag: 'due' | 'scheduled' | 'completion' }

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
    { label: 'Cancelled', detail: '#C', keywords: ['c', 'dropped', 'abandoned'], action: { kind: 'cancelled' } },
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
