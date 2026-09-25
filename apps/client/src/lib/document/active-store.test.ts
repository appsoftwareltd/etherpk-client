import { afterEach, describe, expect, it } from 'vitest'

import { setActiveDocumentStore, getActiveDocumentStore } from './active-store'
import { createInMemoryDocumentStore } from './in-memory-store'

afterEach(() => setActiveDocumentStore(null))

describe('active document store', () => {
    it('throws when no store is set (a View was mounted with no graph open)', () => {
        expect(() => getActiveDocumentStore()).toThrow(/no active document store/i)
    })

    it('returns the store that was set', () => {
        const store = createInMemoryDocumentStore()
        setActiveDocumentStore(store)
        expect(getActiveDocumentStore()).toBe(store)
    })
})
