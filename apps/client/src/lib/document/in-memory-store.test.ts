import { describe, expect, it, vi } from 'vitest'

import { createInMemoryDocumentStore } from './in-memory-store'

describe('in-memory document store', () => {
    it('seeds a document from the fixture and reads it back', () => {
        const store = createInMemoryDocumentStore({ 'doc-a': '# Hello' })
        expect(store.open('doc-a').getText()).toBe('# Hello')
    })

    it('returns the same EditorDocument for the same id (singleton per id)', () => {
        const store = createInMemoryDocumentStore()
        expect(store.open('x')).toBe(store.open('x'))
    })

    it('opens an unseeded id as empty', () => {
        const store = createInMemoryDocumentStore()
        expect(store.open('new').getText()).toBe('')
    })

    it('applies a local change and updates the text', () => {
        const store = createInMemoryDocumentStore({ d: 'abc' })
        const doc = store.open('d')
        doc.applyChange({ from: 3, to: 3, insert: 'd' })
        expect(doc.getText()).toBe('abcd')
    })

    it('does NOT notify subscribers of the editor-originated applyChange (no echo loop)', () => {
        const store = createInMemoryDocumentStore({ d: '' })
        const doc = store.open('d')
        const listener = vi.fn()
        doc.subscribe(listener)
        doc.applyChange({ from: 0, to: 0, insert: 'hi' })
        expect(listener).not.toHaveBeenCalled()
    })

    it('notifies subscribers of an external setText, with the new text', () => {
        const store = createInMemoryDocumentStore({ d: 'old' })
        const doc = store.open('d')
        const listener = vi.fn()
        const off = doc.subscribe(listener)
        store.setText('d', 'new') // simulates a git reload / remote update
        expect(doc.getText()).toBe('new')
        expect(listener).toHaveBeenCalledWith('new')
        off()
        store.setText('d', 'newer')
        expect(listener).toHaveBeenCalledTimes(1) // unsubscribed
    })
})
