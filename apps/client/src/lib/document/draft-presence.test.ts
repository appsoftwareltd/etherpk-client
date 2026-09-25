import { describe, expect, it } from 'vitest'

import { draftConceptNowExists } from './draft-presence'
import type { DocumentStore } from './types'

const bare: DocumentStore = {
    open: () => {
        throw new Error('unused')
    },
}
const listing = (keys: string[]): DocumentStore =>
    ({ ...bare, listDocuments: () => keys.map((key) => ({ key })) }) as DocumentStore
const index = (known: string[]) => ({ conceptExists: (c: string) => known.includes(c) })

describe('draftConceptNowExists', () => {
    it('answers from the store the moment a local create is in its registry, before the index has ingested it', () => {
        // The Quick Notes move creates today's entry; the Draft open on it must rebind now, not
        // whenever the index next runs.
        expect(draftConceptNowExists(listing(['2026-09-17']), index([]), '2026-09-17')).toBe(true)
    })

    it('matches the store by concept identity, not spelling', () => {
        expect(draftConceptNowExists(listing(['physics']), index([]), 'Physics')).toBe(true)
    })

    it('falls back to the index for what arrived by sync ahead of the registry, or a store that cannot list', () => {
        expect(draftConceptNowExists(listing([]), index(['Physics']), 'Physics')).toBe(true)
        expect(draftConceptNowExists(bare, index(['Physics']), 'Physics')).toBe(true)
    })

    it('is false when neither knows the concept, or there is no index to ask', () => {
        expect(draftConceptNowExists(listing(['Other']), index([]), 'Physics')).toBe(false)
        expect(draftConceptNowExists(bare, null, 'Physics')).toBe(false)
    })
})
