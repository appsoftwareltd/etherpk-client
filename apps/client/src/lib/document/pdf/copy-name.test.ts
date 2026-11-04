import { describe, expect, it } from 'vitest'

import { cleanCopyName, copyFileName, describeCopy } from './copy-name'

describe('the name of a saved copy', () => {
    it.each([
        [{ signed: true, annotated: true, password: 'remove' as const }, 'signed'],
        [{ signed: false, annotated: true, password: 'remove' as const }, 'no password'],
        [{ signed: false, annotated: true, password: 'change' as const }, 'password changed'],
        [{ signed: false, annotated: true, password: 'keep' as const }, 'annotated'],
        [{ signed: false, annotated: false, password: 'keep' as const }, 'copy'],
    ])('describes %j as %s', (contents, description) => {
        expect(describeCopy(contents)).toBe(description)
    })

    it('adds what changed to the name', () => {
        expect(copyFileName('garden-guide.pdf', 'signed')).toBe('garden-guide (signed).pdf')
    })

    it('replaces an earlier description, so a copy of a copy does not pile them up', () => {
        expect(copyFileName('garden-guide (annotated).pdf', 'signed')).toBe('garden-guide (signed).pdf')
        expect(copyFileName('garden-guide-annotated.pdf', 'signed')).toBe('garden-guide (signed).pdf')
    })

    it('copes with a name with no extension, and an empty one', () => {
        expect(copyFileName('guide', 'copy')).toBe('guide (copy).pdf')
        expect(copyFileName('.pdf', 'copy')).toBe('document (copy).pdf')
    })

    it('makes a typed name safe', () => {
        expect(cleanCopyName(' Shed plan: final.PDF ')).toBe('Shed plan- final.pdf')
        expect(cleanCopyName('a/b')).toBe('a-b.pdf')
        expect(cleanCopyName('   ')).toBeNull()
    })
})
