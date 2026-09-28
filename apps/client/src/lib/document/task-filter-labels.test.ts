import { describe, expect, it } from 'vitest'

import type { TaskPriorityFilter, TaskStatus } from './backlinks'
import {
    DUE_OPTIONS,
    GROUP_BY_OPTIONS,
    PRIORITY_OPTIONS,
    STATUS_OPTIONS,
    optionLabel,
    priorityFilterLabel,
    sameSelection,
    statusFilterLabel,
} from './task-filter-labels'

// What the Tasks View's filter controls offer, and what Status and Priority say while closed.
// A closed control shows its selection rather than its field, so a common set gets a name and a
// small one lists its members.

describe('statusFilterLabel', () => {
    it.each<[TaskStatus[], string]>([
        [['open', 'doing', 'waiting'], 'Unfinished'],
        [['waiting', 'open', 'doing'], 'Unfinished'],
        [['open', 'doing', 'waiting', 'done', 'cancelled'], 'All statuses'],
        [['cancelled', 'done'], 'Finished'],
        [['doing'], 'Doing'],
        [['waiting', 'open'], 'Open, Waiting'],
        [['open', 'done', 'cancelled'], '3 statuses'],
        [['open', 'doing', 'waiting', 'done'], '4 statuses'],
        [[], 'Choose status'],
    ])('%j reads %s', (statuses, label) => {
        expect(statusFilterLabel(statuses)).toBe(label)
    })
})

describe('priorityFilterLabel', () => {
    it.each<[TaskPriorityFilter[], string]>([
        [[1, 2, 3, null], 'Any priority'],
        [[null, 3, 2, 1], 'Any priority'],
        [[1, 2, 3], 'Prioritised'],
        [[null], 'No priority'],
        [[2], 'P2'],
        [[3, 1], 'P1, P3'],
        [[1, null], '2 priorities'],
        [[2, 3, null], '3 priorities'],
        [[], 'Choose priority'],
    ])('%j reads %s', (priorities, label) => {
        expect(priorityFilterLabel(priorities)).toBe(label)
    })
})

describe('the options', () => {
    it('lists every status in the order a task moves through them', () => {
        expect(STATUS_OPTIONS.map((o) => o.label)).toEqual(['Open', 'Doing', 'Waiting', 'Done', 'Cancelled'])
    })

    it('names the no-priority bucket so it cannot be read as "tick none"', () => {
        expect(PRIORITY_OPTIONS.map((o) => o.label)).toEqual(['P1', 'P2', 'P3', 'No priority'])
        expect(PRIORITY_OPTIONS.at(-1)?.value).toBeNull()
    })
})

describe('the single-choice controls', () => {
    it('name the due windows and the groupings as the closed control shows them', () => {
        expect(DUE_OPTIONS.map((o) => o.label)).toEqual(['Any date', 'Overdue', 'Due today', 'Next 7 days'])
        expect(GROUP_BY_OPTIONS.map((o) => o.label)).toEqual(['By priority', 'By document', 'By due date'])
    })

    it('label a value by its option', () => {
        expect(optionLabel(DUE_OPTIONS, 'next7')).toBe('Next 7 days')
        expect(optionLabel(GROUP_BY_OPTIONS, 'document')).toBe('By document')
    })
})

describe('sameSelection', () => {
    it('compares as sets, so re-ticking an option is not a change', () => {
        expect(sameSelection([1, 2, 3], [3, 1, 2])).toBe(true)
        expect(sameSelection([1, 2], [1, 2, 3])).toBe(false)
        expect(sameSelection([1, null], [1, 2])).toBe(false)
    })
})
