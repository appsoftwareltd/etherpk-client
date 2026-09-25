/**
 * Obsidian task-line conversion: core checkboxes plus the Tasks-plugin emoji grammar
 * (the plan's task table). Alternative checkbox states degrade to the two real states
 * with a minted tag carrying the truth; emoji metadata re-emits as the leading tag run.
 * Recurrence (🔁) is left in place as trailing text - [[Habit]] is undesigned.
 */

import { type TaskTags, taskLine } from './task-tags'
import type { ReportEntry } from './types'

const TASK_LINE = /^(\s*)([-*])\s+\[(.)\]\s?(.*)$/

/** Signifier emoji followed by an ISO date. */
const DATED = /([📅⏳🛫✅➕])\s*(\d{4}-\d{2}-\d{2})/gu
const PRIORITY = /[🔺⏫🔼🔽⏬]/gu
const RECURRENCE = /🔁/u

/**
 * Convert one line if it is a task line; return it untouched otherwise. Report entries
 * record degraded checkbox states and dropped metadata.
 */
export function convertObsidianTaskLine(
    line: string,
    concept: string,
    report: ReportEntry[],
): string {
    const match = TASK_LINE.exec(line)
    if (!match) return line
    const [, indent, bullet, state, rest] = match

    const tags: TaskTags = {}
    let done = false
    if (state === 'x' || state === 'X') done = true
    else if (state === '/') tags.doing = true
    else if (state === '-') {
        done = true
        tags.cancelled = true
    } else if (state !== ' ') {
        report.push({
            category: 'degradation',
            concept,
            detail: `Checkbox state \`[${state}]\` has no EtherPK equivalent; converted to an open task`,
        })
    }

    let text = rest

    text = text.replace(DATED, (_all, emoji: string, date: string) => {
        if (emoji === '📅') tags.due = date
        else if (emoji === '⏳') tags.scheduled = date
        else if (emoji === '✅') tags.completed = date
        else if (emoji === '🛫') {
            // Start folds into #S- only when no ⏳ claims it (checked after the pass).
            tags.scheduled ??= `start:${date}`
        } else {
            report.push({ category: 'drop', concept, detail: `Created date ➕ ${date} dropped` })
        }
        return ' '
    })
    // A ⏳ later in the line overrides a provisional 🛫; a real 🛫-only fold sheds the marker.
    if (tags.scheduled?.startsWith('start:')) {
        tags.scheduled = tags.scheduled.slice('start:'.length)
    } else if (/🛫/u.test(rest) && tags.scheduled) {
        report.push({
            category: 'drop',
            concept,
            detail: 'Start date 🛫 dropped (a scheduled ⏳ date is present)',
        })
    }

    text = text.replace(PRIORITY, (emoji) => {
        if (emoji === '🔺') tags.priority ??= 1
        else if (emoji === '⏫') tags.priority ??= 2
        else if (emoji === '🔼') tags.priority ??= 3
        else
            report.push({
                category: 'drop',
                concept,
                detail: `Below-normal priority ${emoji} dropped (no #P level below normal)`,
            })
        return ' '
    })

    if (RECURRENCE.test(text)) {
        report.push({
            category: 'unsupported',
            concept,
            detail: 'Recurrence 🔁 left as text (recurring tasks are not yet designed)',
        })
    }

    text = text.replace(/\s{2,}/g, ' ').trim()
    return taskLine(indent, bullet, done, tags, text)
}
