import { describe, expect, it } from 'vitest'
import { duplicateNoticeMessage, mergeConfirmation, mergeOutcomeMessage, offersDuplicateReview } from './duplicate-names-copy'

describe('offersDuplicateReview', () => {
    const base = { registryConfirmed: true, names: 2, dismissed: false, otherDialogOpen: false }

    it('offers the review once the registry is confirmed and a name has more than one document', () => {
        expect(offersDuplicateReview(base)).toBe(true)
    })

    it('stays quiet without a confirmed registry, without duplicates, after Not now, and behind another dialog', () => {
        expect(offersDuplicateReview({ ...base, registryConfirmed: false })).toBe(false)
        expect(offersDuplicateReview({ ...base, names: 0 })).toBe(false)
        expect(offersDuplicateReview({ ...base, dismissed: true })).toBe(false)
        expect(offersDuplicateReview({ ...base, otherDialogOpen: true })).toBe(false)
    })
})

describe('duplicateNoticeMessage', () => {
    it('counts the names', () => {
        expect(duplicateNoticeMessage(2)).toBe(
            '2 names in this graph belong to more than one document. Each name opens only one of them, so the text in the others is hidden.',
        )
        expect(duplicateNoticeMessage(1)).toBe(
            '1 name in this graph belongs to more than one document. The name opens only one of them, so the text in the others is hidden.',
        )
    })
})

describe('mergeConfirmation', () => {
    it('names the documents, their sizes, and what happens to each', () => {
        expect(mergeConfirmation('2026-03-14', [48, 20])).toBe(
            'Merge 2 documents named 2026-03-14 (48 and 20 lines)? The text of the second is added to the first, then the second is deleted.',
        )
        expect(mergeConfirmation('Garden', [40, 12, 1])).toBe(
            'Merge 3 documents named Garden (40, 12 and 1 lines)? The text of the others is added to the first, then the others are deleted.',
        )
    })
})

describe('mergeOutcomeMessage', () => {
    it('says what happened and what to do next for every outcome but a merge', () => {
        for (const outcome of ['gone', 'offline', 'unconfirmed', 'protected', 'changed', 'not-acknowledged', 'changed-after-append'] as const) {
            expect(mergeOutcomeMessage(outcome)).toMatch(/\.$/)
        }
        expect(mergeOutcomeMessage('not-acknowledged')).toContain('Nothing was deleted')
        expect(mergeOutcomeMessage('merged')).toBeNull()
    })
})
