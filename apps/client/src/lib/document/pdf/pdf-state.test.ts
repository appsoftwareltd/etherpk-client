import { describe, expect, it } from 'vitest'

import { sanitizeAnnotation, sanitizePdfState, sanitizePlace } from './pdf-state'

const base = { id: 'a', page: 2, colour: '#ffd400', createdAt: 1, updatedAt: 2 }

describe('reading a stored PDF state', () => {
    it('keeps a highlight, stroke and note', () => {
        const highlight = { ...base, kind: 'highlight', quads: [0, 0, 1, 0, 0, 1, 1, 1], text: 'water the beans' }
        const stroke = { ...base, kind: 'stroke', tool: 'pen', width: 1.5, points: [1, 2, 3, 4] }
        const note = { ...base, kind: 'note', x: 10, y: 20, fontSize: 12, text: 'Compare with the shed' }
        expect(sanitizeAnnotation(highlight)).toEqual(highlight)
        expect(sanitizeAnnotation(stroke)).toEqual(stroke)
        expect(sanitizeAnnotation(note)).toEqual(note)
    })

    it.each([
        ['a page before the first', { ...base, kind: 'note', x: 1, y: 1, fontSize: 12, text: 'x', page: 0 }],
        ['a colour that is not a colour', { ...base, kind: 'note', x: 1, y: 1, fontSize: 12, text: 'x', colour: 'url(#a)' }],
        ['quads that do not come in eights', { ...base, kind: 'highlight', quads: [1, 2, 3] }],
        ['a stroke with half a point', { ...base, kind: 'stroke', tool: 'pen', width: 1, points: [1, 2, 3] }],
        ['a stroke with an unknown tool', { ...base, kind: 'stroke', tool: 'brush', width: 1, points: [1, 2] }],
        ['an unknown kind', { ...base, kind: 'stamp' }],
        ['no id', { ...base, id: '', kind: 'note', x: 1, y: 1, fontSize: 12, text: 'x' }],
    ])('drops %s', (_name, raw) => {
        expect(sanitizeAnnotation(raw)).toBeNull()
    })

    it('leaves out fields it does not know', () => {
        const kept = sanitizeAnnotation({ ...base, kind: 'note', x: 1, y: 1, fontSize: 12, text: 'x', script: 'nope' })
        expect(kept).not.toHaveProperty('script')
    })

    it('keeps the good entries of a damaged file', () => {
        const state = sanitizePdfState({
            annotations: [{ ...base, kind: 'note', x: 1, y: 1, fontSize: 12, text: 'x' }, 'junk'],
            forms: { '12R': { value: 'Sam' }, bad: 3 },
        })
        expect(state.annotations).toHaveLength(1)
        expect(state.forms).toEqual({ '12R': { value: 'Sam' } })
    })

    it('reads anything else as an empty state', () => {
        expect(sanitizePdfState('nope')).toEqual({ annotations: [], forms: {} })
    })

    it('holds a place to the page it can describe', () => {
        expect(sanitizePlace({ page: 4, offset: 3, at: 1 })).toEqual({ page: 4, offset: 1, at: 1 })
        expect(sanitizePlace({ page: 0, offset: 0, at: 1 })).toBeUndefined()
    })
})

describe('a stroke drawn with pressure', () => {
    const base = { id: 'a', page: 1, colour: '#111827', createdAt: 1, updatedAt: 1, kind: 'stroke', tool: 'pen', width: 1.4, points: [0, 0, 1, 1] }

    it('keeps one pressure for each point', () => {
        expect(sanitizeAnnotation({ ...base, pressures: [0.2, 0.8] })).toMatchObject({ pressures: [0.2, 0.8] })
    })

    it('reads a stroke with no pressures as an even line', () => {
        expect(sanitizeAnnotation(base)).not.toHaveProperty('pressures')
    })

    it.each([[[0.2]], [[0.2, 2]], [['a', 'b']], ['x']])('drops pressures that do not fit: %j', (pressures) => {
        const parsed = sanitizeAnnotation({ ...base, pressures })
        expect(parsed).not.toBeNull()
        expect(parsed).not.toHaveProperty('pressures')
    })
})
