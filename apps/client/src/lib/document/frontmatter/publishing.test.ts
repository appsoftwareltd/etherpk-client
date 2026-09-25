import { describe, expect, it } from 'vitest'

import { withPublishing } from './publishing'

describe('withPublishing', () => {
    it('adds a block to a document without one only when asked', () => {
        expect(withPublishing('- body\n', { public: true })).toBe('- body\n')
        expect(withPublishing('- body\n', { public: true, publications: ['docs'] }, { addBlock: true })).toBe(
            '---\npublic: true\npublications:\n  - docs\n---\n- body\n',
        )
    })

    it('sets the keys in an existing block, keeping other keys and their order', () => {
        const text = '---\ntitle: Guide\naliases:\n  - G\n---\n- body\n'
        expect(withPublishing(text, { public: true, publications: ['docs', 'blog'] })).toBe(
            '---\ntitle: Guide\naliases:\n  - G\npublic: true\npublications:\n  - docs\n  - blog\n---\n- body\n',
        )
    })

    it('returns the same string when nothing changes', () => {
        const text = '---\npublic: true\npublications:\n  - docs\n---\n- body\n'
        expect(withPublishing(text, { public: true, publications: ['docs'] })).toBe(text)
        expect(withPublishing(text, {})).toBe(text)
    })

    it('removes a key with null, an empty list on a non-public document, and the block when it is emptied', () => {
        const text = '---\npublic: true\npublications:\n  - docs\n---\n- body\n'
        expect(withPublishing(text, { public: null, publications: [] })).toBe('- body\n')
        expect(withPublishing('---\ntitle: T\npublic: true\n---\n- b\n', { public: null })).toBe('---\ntitle: T\n---\n- b\n')
    })

    it('writes an empty publications list on a public document, as the prompt to fill it', () => {
        // Public with nowhere to go is the state the Publish dialog warns about; the key left in
        // the block, empty, is the same prompt to whoever edits the file by hand.
        expect(withPublishing('- body\n', { public: true, publications: [] }, { addBlock: true })).toBe('---\npublic: true\npublications: []\n---\n- body\n')
        expect(withPublishing('---\ntitle: T\n---\n- b\n', { public: true, publications: [] })).toBe('---\ntitle: T\npublic: true\npublications: []\n---\n- b\n')
        expect(withPublishing('---\ntitle: T\npublic: true\npublications:\n  - docs\n---\n- b\n', { publications: [] })).toBe('---\ntitle: T\npublic: true\npublications: []\n---\n- b\n')
        // Not public: an empty list is nothing to prompt for, so the key goes.
        expect(withPublishing('---\ntitle: T\npublications:\n  - docs\n---\n- b\n', { publications: [] })).toBe('---\ntitle: T\n---\n- b\n')
        expect(withPublishing('---\ntitle: T\n---\n- b\n', { publications: [] })).toBe('---\ntitle: T\n---\n- b\n')
    })

    it('drops ids that are not publication ids and duplicates', () => {
        expect(withPublishing('---\ntitle: T\n---\n', { publications: ['docs', 'Not Ok', 'docs'] })).toBe('---\ntitle: T\npublications:\n  - docs\n---\n')
    })

    it('leaves a block whose YAML does not parse alone', () => {
        const text = '---\ntitle: [unclosed\n---\n- b\n'
        expect(withPublishing(text, { public: true })).toBe(text)
    })
})
