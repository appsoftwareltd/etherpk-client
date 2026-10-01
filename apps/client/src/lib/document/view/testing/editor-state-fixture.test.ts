import { describe, expect, it } from 'vitest'

import { parseFixture } from './editor-state-fixture'

describe('parseFixture', () => {
    it('reads a caret', () => {
        expect(parseFixture('ab|c')).toEqual({ doc: 'abc', anchor: 2, head: 2 })
    })

    it('reads «…» as a range with the head at its end', () => {
        expect(parseFixture('a«bc»d')).toEqual({ doc: 'abcd', anchor: 1, head: 3 })
    })

    it('reads »…« as the same range with the head at its start', () => {
        expect(parseFixture('a»bc«d')).toEqual({ doc: 'abcd', anchor: 3, head: 1 })
    })

    it('refuses a marker without its partner, or a second pair', () => {
        expect(() => parseFixture('a«bc')).toThrow(/Unbalanced/)
        expect(() => parseFixture('a«b»c«d»')).toThrow(/Unbalanced/)
    })
})
