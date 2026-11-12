import { describe, expect, it } from 'vitest'

import { fileUnderChoices } from './quick-note-filing'

describe('fileUnderChoices', () => {
    it('offers favourited documents in the order the person keeps them', () => {
        expect(fileUnderChoices(['Shopping', 'Garden', 'Kitchen'])).toEqual(['Shopping', 'Garden', 'Kitchen'])
    })

    it('leaves out a favourited View and a journal day', () => {
        expect(fileUnderChoices(['Shopping', { kind: 'tasks' }, '2026-09-17', { kind: 'asset', concept: 'a.pdf', name: 'a.pdf' }])).toEqual(['Shopping'])
    })
})
