import { describe, expect, it } from 'vitest'

import { withFrontmatterPatch } from './patch'

describe('withFrontmatterPatch', () => {
    it('sets nested mappings and lists, keeping the other keys in order', () => {
        const out = withFrontmatterPatch('---\ntitle: Docs Site\n---\n- [[Home]]\n', { publication: { id: 'docs', kind: 'docs', includes: { footer: 'F' } } })
        expect(out).toBe('---\ntitle: Docs Site\npublication:\n  id: docs\n  kind: docs\n  includes:\n    footer: F\n---\n- [[Home]]\n')
    })

    it('replaces, removes and leaves unchanged', () => {
        const text = '---\na: 1\nb: 2\n---\n'
        expect(withFrontmatterPatch(text, { a: 1 })).toBe(text)
        expect(withFrontmatterPatch(text, { a: null })).toBe('---\nb: 2\n---\n')
        expect(withFrontmatterPatch(text, { a: null, b: null })).toBe('')
        expect(withFrontmatterPatch(text, { b: 3, c: 'x' })).toBe('---\na: 1\nb: 3\nc: x\n---\n')
    })

    it('adds a block only when asked and never to a malformed one', () => {
        expect(withFrontmatterPatch('- body\n', { a: 1 })).toBe('- body\n')
        expect(withFrontmatterPatch('- body\n', { a: 1 }, { addBlock: true })).toBe('---\na: 1\n---\n- body\n')
        const bad = '---\na: [\n---\n'
        expect(withFrontmatterPatch(bad, { a: 1 })).toBe(bad)
    })
})
