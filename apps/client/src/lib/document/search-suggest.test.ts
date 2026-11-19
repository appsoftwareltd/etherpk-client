import { describe, expect, it } from 'vitest'

import { applySearchSuggestion, keyCompletion, keySuggestions, suggestionContext, valueSuggestions } from './search-suggest'

const known = new Set(['public', 'status', 'publication.id'])
const keys = [
    { key: 'public', documents: 4 },
    { key: 'status', documents: 3 },
    { key: 'Status', documents: 1 },
    { key: 'publication.id', documents: 1 },
]

describe('suggestionContext', () => {
    it('offers keys while a bare word is typed', () => {
        expect(suggestionContext('meeting pu', 10, known)).toEqual({ kind: 'key', from: 8, to: 10, prefix: 'pu', negated: false })
    })

    it('offers values after the colon of a key the graph uses', () => {
        expect(suggestionContext('status:dr', 9, known)).toEqual({ kind: 'value', from: 0, to: 9, key: 'status', prefix: 'dr', negated: false })
        expect(suggestionContext('-status:"in', 11, known)).toEqual({ kind: 'value', from: 0, to: 11, key: 'status', prefix: 'in', negated: true })
    })

    it('offers nothing in the gap between words, in a quoted phrase, or after an unknown key', () => {
        expect(suggestionContext('status ', 7, known)).toBeNull()
        expect(suggestionContext('"pub', 4, known)).toBeNull()
        expect(suggestionContext('http://x', 8, known)).toBeNull()
    })
})

describe('keySuggestions and valueSuggestions', () => {
    it('offers keys that start with what was typed, each spelling, most used first', () => {
        const context = { kind: 'key' as const, from: 0, to: 2, prefix: 'st', negated: false }
        expect(keySuggestions(context, keys).map((s) => s.text)).toEqual(['status', 'Status'])
    })

    it('offers values that start with what was typed, ignoring case', () => {
        const context = { kind: 'value' as const, from: 0, to: 9, key: 'status', prefix: 'D', negated: false }
        const values = [
            { value: 'draft', documents: 2 },
            { value: 'done', documents: 1 },
            { value: 'archived', documents: 1 },
        ]
        expect(valueSuggestions(context, values).map((s) => s.text)).toEqual(['draft', 'done'])
    })
})

describe('applySearchSuggestion', () => {
    it('completes a key with its colon, caret after it, ready for a value', () => {
        const context = { kind: 'key' as const, from: 8, to: 10, prefix: 'pu', negated: false }
        expect(applySearchSuggestion('meeting pu', context, { kind: 'key', text: 'public', documents: 4 })).toEqual({ value: 'meeting public:', caret: 15 })
    })

    it('completes a value, quoting one with a space, and moves past it', () => {
        const context = { kind: 'value' as const, from: 0, to: 10, key: 'status', prefix: 'in', negated: true }
        expect(applySearchSuggestion('-status:in meeting', context, { kind: 'value', text: 'in progress', documents: 1 })).toEqual({
            value: '-status:"in progress" meeting',
            caret: 22,
        })
    })

    it('adds a space after a value completed at the end of the box', () => {
        const context = { kind: 'value' as const, from: 0, to: 9, key: 'status', prefix: 'dr', negated: false }
        expect(applySearchSuggestion('status:dr', context, { kind: 'value', text: 'draft', documents: 2 })).toEqual({ value: 'status:draft ', caret: 13 })
    })
})

describe('keyCompletion: the ghost text after the caret', () => {
    const keys = [
        { key: 'title', documents: 9 },
        { key: 'template', documents: 4 },
        { key: 'status', documents: 2 },
    ]
    const known = new Set(keys.map((info) => info.key))
    const at = (input: string, caret = input.length) => keyCompletion(input, caret, suggestionContext(input, caret, known), keys)

    it('shows the rest of the first key that starts with what is typed, with its colon', () => {
        expect(at('t')).toMatchObject({ rest: 'itle:', suggestion: { kind: 'key', text: 'title' } })
        expect(at('te')).toMatchObject({ rest: 'mplate:', suggestion: { text: 'template' } })
        expect(at('title')).toMatchObject({ rest: ':' })
    })

    it('reads the typed letters in any case, and after a minus', () => {
        expect(at('TI')?.rest).toBe('tle:')
        expect(at('beans -st')?.rest).toBe('atus:')
    })

    it('shows nothing mid-word, after a colon, or where no key starts with what is typed', () => {
        expect(at('title', 2)).toBeNull()
        expect(at('status:')).toBeNull()
        expect(at('beans')).toBeNull()
        expect(at('')).toBeNull()
    })
})
