/**
 * The [[Tasks View]]'s filter options, and what the Status and Priority controls say while closed.
 *
 * A closed control shows the selection rather than the field (a phone leaves the field's name
 * out for space), so it names the selection: a set people ask for often gets a word of its
 * own ("Unfinished", "Prioritised"), one or two options are listed, and anything larger is
 * counted. An empty selection reads as a prompt ("Choose status"), because it matches nothing
 * and the only useful thing to do with it is tick something.
 */

import {
    OPEN_TASK_STATUSES,
    TASK_PRIORITY_FILTERS,
    TASK_STATUSES,
    type TaskDueWindow,
    type TaskGroupBy,
    type TaskPriorityFilter,
    type TaskStatus,
} from './backlinks'

export interface FilterOption<T> {
    value: T
    label: string
}

/** In the order a task moves through them, which is also the order a label lists them in. */
export const STATUS_OPTIONS: ReadonlyArray<FilterOption<TaskStatus>> = [
    { value: 'open', label: 'Open' },
    { value: 'doing', label: 'Doing' },
    { value: 'waiting', label: 'Waiting' },
    { value: 'done', label: 'Done' },
    { value: 'cancelled', label: 'Cancelled' },
]

/**
 * "No priority" rather than "None": in a list of checkboxes a row called None reads as
 * "tick none of these", when it is the real bucket of tasks that carry no priority tag.
 */
export const PRIORITY_OPTIONS: ReadonlyArray<FilterOption<TaskPriorityFilter>> = [
    { value: 1, label: 'P1' },
    { value: 2, label: 'P2' },
    { value: 3, label: 'P3' },
    { value: null, label: 'No priority' },
]

/** One choice each: what a Due or Group by control shows is simply its option's label. */
export const DUE_OPTIONS: ReadonlyArray<FilterOption<TaskDueWindow>> = [
    { value: 'any', label: 'Any date' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'today', label: 'Due today' },
    { value: 'next7', label: 'Next 7 days' },
]

export const GROUP_BY_OPTIONS: ReadonlyArray<FilterOption<TaskGroupBy>> = [
    { value: 'priority', label: 'By priority' },
    { value: 'document', label: 'By document' },
    { value: 'due', label: 'By due date' },
]

/** The label of the option holding `value`, or an empty string for a value no option offers. */
export function optionLabel<T>(options: ReadonlyArray<FilterOption<T>>, value: T): string {
    return options.find((option) => option.value === value)?.label ?? ''
}

const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled']
const SET_PRIORITIES: readonly TaskPriorityFilter[] = [1, 2, 3]

/**
 * Whether two selections hold the same options. Compared as sets: unticking an option and
 * ticking it again moves it to the end of the array, and that is not a different filter.
 */
export function sameSelection<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((x) => b.includes(x))
}

export function statusFilterLabel(statuses: readonly TaskStatus[]): string {
    if (sameSelection(statuses, OPEN_TASK_STATUSES)) return 'Unfinished'
    if (sameSelection(statuses, TASK_STATUSES)) return 'All statuses'
    if (sameSelection(statuses, FINISHED_TASK_STATUSES)) return 'Finished'
    return selectionLabel(statuses, STATUS_OPTIONS, { empty: 'Choose status', plural: 'statuses' })
}

export function priorityFilterLabel(priorities: readonly TaskPriorityFilter[]): string {
    if (sameSelection(priorities, TASK_PRIORITY_FILTERS)) return 'Any priority'
    if (sameSelection(priorities, SET_PRIORITIES)) return 'Prioritised'
    // "P1, No priority" is long for the width a control gets; a mix with the bucket is counted.
    if (priorities.length === 2 && priorities.includes(null)) return '2 priorities'
    return selectionLabel(priorities, PRIORITY_OPTIONS, { empty: 'Choose priority', plural: 'priorities' })
}

/** Nothing, one or two options by name (in the options' order), or a count. */
function selectionLabel<T>(
    selected: readonly T[],
    options: ReadonlyArray<FilterOption<T>>,
    words: { empty: string; plural: string },
): string {
    if (selected.length === 0) return words.empty
    if (selected.length > 2) return `${selected.length} ${words.plural}`
    return options
        .filter((option) => selected.includes(option.value))
        .map((option) => option.label)
        .join(', ')
}
