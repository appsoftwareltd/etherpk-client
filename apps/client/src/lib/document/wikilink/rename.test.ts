import { describe, expect, it } from 'vitest'

import { cascadeFor, countWikilinkTargets, isScopedBy, rewriteWikilinkScope, rewriteWikilinkTarget, wikilinkScopeSplices } from './rename'

describe('rewriteWikilinkTarget', () => {
    it('rewrites a top-level link', () => {
        const result = rewriteWikilinkTarget('see [[Physics]] today', 'Physics', 'Physical Science')
        expect(result.text).toBe('see [[Physical Science]] today')
        expect(result.count).toBe(1)
    })

    it('rewrites every occurrence, across lines', () => {
        const source = '- [[Physics]]\n- more [[Physics]] here\n- [[Recipes]]'
        const result = rewriteWikilinkTarget(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(2)
        expect(result.text).toBe('- [[Physical Science]]\n- more [[Physical Science]] here\n- [[Recipes]]')
    })

    it('matches case-insensitively, like Concept identity', () => {
        const result = rewriteWikilinkTarget('see [[physics]]', 'Physics', 'Physical Science')
        expect(result.text).toBe('see [[Physical Science]]')
    })

    it('LEAVES a scoped concept alone', () => {
        // `[[[[Physics]] Quantum]]` references the scoped concept "[[Physics]] Quantum",
        // which is a DIFFERENT concept and was not renamed. Rewriting the inner scope would
        // silently re-point the link at a scoped concept that does not exist.
        const source = 'see [[[[Physics]] Quantum]] and [[Physics]]'
        const result = rewriteWikilinkTarget(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('see [[[[Physics]] Quantum]] and [[Physical Science]]')
    })

    it('leaves links inside a fenced code block alone', () => {
        const source = '```\n[[Physics]]\n```\n[[Physics]]'
        const result = rewriteWikilinkTarget(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('```\n[[Physics]]\n```\n[[Physical Science]]')
    })

    it('leaves links inside inline code alone', () => {
        const source = 'use `[[Physics]]` then [[Physics]]'
        const result = rewriteWikilinkTarget(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('use `[[Physics]]` then [[Physical Science]]')
    })

    it('does not touch a different concept that merely contains the name', () => {
        const source = '[[Physics Notes]] and [[Physics]]'
        const result = rewriteWikilinkTarget(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('[[Physics Notes]] and [[Physical Science]]')
    })

    it('is a no-op when nothing references the name', () => {
        const source = '[[Recipes]] only'
        expect(rewriteWikilinkTarget(source, 'Physics', 'X')).toEqual({ text: source, count: 0 })
    })

    it('handles a rename to a longer AND shorter name without corrupting offsets', () => {
        // Edits are applied back-to-front; a length change must not shift later targets.
        const source = '[[A]] [[A]] [[A]]'
        expect(rewriteWikilinkTarget(source, 'A', 'Much Longer Name').text).toBe(
            '[[Much Longer Name]] [[Much Longer Name]] [[Much Longer Name]]',
        )
        expect(rewriteWikilinkTarget('[[Long Name]] [[Long Name]]', 'Long Name', 'X').text).toBe('[[X]] [[X]]')
    })

    it('ignores an empty source name rather than matching everything', () => {
        expect(rewriteWikilinkTarget('[[A]]', '   ', 'X')).toEqual({ text: '[[A]]', count: 0 })
    })
})

describe('rewriteWikilinkScope', () => {
    it('rewrites a NESTED occurrence - the inverse of rewriteWikilinkTarget', () => {
        // The whole point of the cascade: the inner [[Physics]] IS the scope, and renaming it
        // is what renames the scoped concept.
        const result = rewriteWikilinkScope('see [[[[Physics]] Quantum]]', 'Physics', 'Physical Science')
        expect(result.text).toBe('see [[[[Physical Science]] Quantum]]')
        expect(result.count).toBe(1)
    })

    it('rewrites top-level and nested occurrences together', () => {
        const source = '[[Physics]] and [[[[Physics]] Quantum]]'
        const result = rewriteWikilinkScope(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(2)
        expect(result.text).toBe('[[Physical Science]] and [[[[Physical Science]] Quantum]]')
    })

    it('handles arbitrary depth through the innermost occurrence alone', () => {
        const source = '[[[[[[Physics]] Quantum]] Field Theory]]'
        const result = rewriteWikilinkScope(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('[[[[[[Physical Science]] Quantum]] Field Theory]]')
    })

    it('rewrites a CONCEPT string, which is how a scoped document is renamed', () => {
        // A scoped concept's name is this literal string - no brackets around the whole thing.
        expect(rewriteWikilinkScope('[[Physics]] Quantum Mechanics', 'Physics', 'Physical Science').text).toBe(
            '[[Physical Science]] Quantum Mechanics',
        )
    })

    it('still skips links inside code', () => {
        const source = '```\n[[[[Physics]] Quantum]]\n```\n[[[[Physics]] Quantum]]'
        const result = rewriteWikilinkScope(source, 'Physics', 'Physical Science')
        expect(result.count).toBe(1)
        expect(result.text).toBe('```\n[[[[Physics]] Quantum]]\n```\n[[[[Physical Science]] Quantum]]')
    })

    it('matches case-insensitively but leaves a different concept alone', () => {
        expect(rewriteWikilinkScope('[[physics]] Quantum', 'Physics', 'X').text).toBe('[[X]] Quantum')
        expect(rewriteWikilinkScope('[[Physics Notes]] Quantum', 'Physics', 'X').count).toBe(0)
    })

    it('is a no-op for an empty source name', () => {
        expect(rewriteWikilinkScope('[[A]]', '  ', 'X')).toEqual({ text: '[[A]]', count: 0 })
    })
})

describe('isScopedBy', () => {
    it('recognises scoping at any depth, and only scoping', () => {
        expect(isScopedBy('[[Physics]] Quantum', 'Physics')).toBe(true)
        expect(isScopedBy('[[[[Physics]] Quantum]] Fields', 'Physics')).toBe(true)
        expect(isScopedBy('[[[[Physics]] Quantum]] Fields', 'Quantum')).toBe(false) // Quantum is not a link here
        expect(isScopedBy('Physics', 'Physics')).toBe(false) // the concept itself, not scoped by it
        expect(isScopedBy('[[Chemistry]] Quantum', 'Physics')).toBe(false)
    })
})

describe('cascadeFor', () => {
    it('returns every scoped concept with the name it becomes', () => {
        const concepts = [
            'Physics',
            '[[Physics]] Quantum',
            '[[[[Physics]] Quantum]] Fields',
            '[[Chemistry]] Organic',
            'Unrelated',
        ]
        expect(cascadeFor(concepts, 'Physics', 'Physical Science')).toEqual([
            { from: '[[Physics]] Quantum', to: '[[Physical Science]] Quantum' },
            { from: '[[[[Physics]] Quantum]] Fields', to: '[[[[Physical Science]] Quantum]] Fields' },
        ])
    })

    it('excludes the renamed concept itself', () => {
        // The direct rename is not part of its own cascade.
        expect(cascadeFor(['Physics'], 'Physics', 'X')).toEqual([])
    })

    it('is empty when nothing is scoped by the name', () => {
        expect(cascadeFor(['A', 'B'], 'Physics', 'X')).toEqual([])
    })
})

describe('countWikilinkTargets', () => {
    it('counts what a rewrite would actually change', () => {
        const source = '[[Physics]] [[[[Physics]] Quantum]] `[[Physics]]` [[Physics]]'
        // Two top-level, outside code: the scoped one and the inline-code one do not move,
        // so the rename dialog must not promise to update them.
        expect(countWikilinkTargets(source, 'Physics')).toBe(2)
    })
})

describe('wikilinkScopeSplices', () => {
    it('yields one ascending splice per occurrence, at any depth, in original offsets', () => {
        const source = '- [[Physics]] and [[[[Physics]] Quantum]]\n- `[[Physics]]` in code'
        const splices = wikilinkScopeSplices(source, 'Physics', 'Physical Science')
        expect(splices).toEqual([
            { from: 4, to: 11, insert: 'Physical Science' },
            { from: 22, to: 29, insert: 'Physical Science' },
        ])
        // Applying them back-to-front is exactly rewriteWikilinkScope.
        expect(rewriteWikilinkScope(source, 'Physics', 'Physical Science').text).toBe(
            '- [[Physical Science]] and [[[[Physical Science]] Quantum]]\n- `[[Physics]]` in code',
        )
    })

    it('is empty when nothing matches', () => {
        expect(wikilinkScopeSplices('- [[Chemistry]]', 'Physics', 'X')).toEqual([])
        expect(wikilinkScopeSplices('- [[Physics]]', '', 'X')).toEqual([])
    })
})
