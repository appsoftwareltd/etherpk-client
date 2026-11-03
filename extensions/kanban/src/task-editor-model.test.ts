import { describe, expect, it } from 'vitest'

import { createHeldDocument, DATE_FIELDS, freeTagProblem, isUntouched, PRIORITY_CHOICES, readFreeTag } from './task-editor-model'

describe('a Free Tag typed into the Task Editor', () => {
    it('is read without its #, trimmed', () => {
        expect(readFreeTag('  #needs-oil ')).toBe('needs-oil')
    })

    it('is refused, with a reason, when it is no Free Tag or the task has it already', () => {
        expect(freeTagProblem('', [])).toBe('Type a tag first.')
        expect(freeTagProblem('my_tag', [])).toMatch(/letters and digits/)
        expect(freeTagProblem('a--b', [])).toMatch(/letters and digits/)
        expect(freeTagProblem('2026', [])).toMatch(/at least one letter/)
        expect(freeTagProblem('P1', [])).toMatch(/task tag/)
        expect(freeTagProblem('Bug', ['bug'])).toMatch(/already/)
        expect(freeTagProblem('needs-oil', ['bug'])).toBeNull()
    })
})

describe('the date fields', () => {
    it('run Due then Scheduled, each writing its dated task tag', () => {
        expect(DATE_FIELDS.map((entry) => [entry.label, entry.tag])).toEqual([
            ['Due', '#D-'],
            ['Scheduled', '#S-'],
        ])
    })
})

describe('the priority chips', () => {
    it('run None, P1, P2, P3, the priorities drawn in the graph colour set', () => {
        expect(PRIORITY_CHOICES.map((choice) => [choice.label, choice.priority])).toEqual([
            ['None', null],
            ['P1', 1],
            ['P2', 2],
            ['P3', 3],
        ])
        expect(PRIORITY_CHOICES[0].colour).toBeNull()
        for (const choice of PRIORITY_CHOICES.slice(1)) expect(choice.colour).toMatch(/^#[0-9a-f]{6}$/)
    })
})

describe('a new task left untouched', () => {
    const blank = { title: '', status: 'open' as const, priority: null, freeTags: [], due: null, scheduled: null }

    it('is untouched with nothing typed, so closing asks nothing', () => {
        expect(isUntouched(blank, 'open', '- ')).toBe(true)
        expect(isUntouched(blank, 'open', '')).toBe(true)
    })

    it('is touched once anything is typed or chosen', () => {
        expect(isUntouched({ ...blank, title: 'Build' }, 'open', '- ')).toBe(false)
        expect(isUntouched({ ...blank, status: 'doing' }, 'open', '- ')).toBe(false)
        expect(isUntouched({ ...blank, priority: 2 }, 'open', '- ')).toBe(false)
        expect(isUntouched({ ...blank, freeTags: ['bug'] }, 'open', '- ')).toBe(false)
        expect(isUntouched({ ...blank, due: '2026-11-09' }, 'open', '- ')).toBe(false)
        expect(isUntouched({ ...blank, scheduled: '2026-11-05' }, 'open', '- ')).toBe(false)
        expect(isUntouched(blank, 'open', '- measure')).toBe(false)
    })
})

describe('the document a new task is described in', () => {
    it('holds its text, and tells its listeners of every change but their own', () => {
        const held = createHeldDocument('- ')
        const heard: string[] = []
        const editor = (text: string) => heard.push(`editor: ${text}`)
        held.subscribe(editor)
        held.subscribe((text) => heard.push(`other: ${text}`))
        held.applyChange({ from: 2, to: 2, insert: 'a' }, 'editor', editor)
        held.applyChange({ from: 3, to: 3, insert: '\n- ' }, 'external')
        expect(held.getText()).toBe('- a\n- ')
        expect(heard).toEqual(['other: - a', 'editor: - a\n- ', 'other: - a\n- '])
    })
})
