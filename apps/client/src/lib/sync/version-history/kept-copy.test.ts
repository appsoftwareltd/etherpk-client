import { describe, expect, it } from 'vitest'
import { deleteFileQuestion, deleteOutcomeSentence } from './kept-copy'

describe('delete confirmation copy (ADR 0184)', () => {
    it('says a delete is permanent where nothing is kept, and how long it is kept otherwise', () => {
        expect(deleteOutcomeSentence(undefined)).toBe('This cannot be undone.')
        expect(deleteOutcomeSentence(0)).toBe('This cannot be undone.')
        expect(deleteOutcomeSentence(30)).toBe('Any member can restore it from All Documents for 30 days.')
    })

    it('asks about a PDF or EBook the same way', () => {
        expect(deleteFileQuestion('Seeds.pdf', '3 annotations', undefined)).toBe(
            'Delete Seeds.pdf, permanently, with your 3 annotations? This cannot be undone.',
        )
        expect(deleteFileQuestion('Seeds.pdf', null, 30)).toBe('Delete Seeds.pdf? Any member can restore it from All Documents for 30 days.')
    })
})
