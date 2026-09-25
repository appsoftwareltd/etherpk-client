import { describe, expect, it } from 'vitest'

import { describeFilesystemSaveFailure } from './save-error-copy'

describe('describeFilesystemSaveFailure', () => {
    it('names the document, then says what happened and what to do', () => {
        const copy = describeFilesystemSaveFailure(new DOMException('full', 'QuotaExceededError'), 'Physics')
        expect(copy).toMatch(/^Could not save “Physics”\./)
        expect(copy).toContain('full')
        expect(copy).toContain('retry')
        expect(copy).toContain('kept in this tab')
    })

    it('maps the File System Access fault names to their causes', () => {
        const copyFor = (name: string) => describeFilesystemSaveFailure(new DOMException('x', name), 'A')
        expect(copyFor('NotAllowedError')).toContain('Permission')
        expect(copyFor('SecurityError')).toContain('Permission')
        expect(copyFor('NoModificationAllowedError')).toContain('locked by another program')
        expect(copyFor('NotFoundError')).toContain('no longer where it was')
        expect(copyFor('NotReadableError')).toContain('could not be read when it was opened')
        expect(copyFor('InvalidStateError')).toContain('Another program was using the file')
    })

    it('falls back to the browser’s own message, never to a sentence about a sync server', () => {
        const copy = describeFilesystemSaveFailure(new Error('Something odd'), 'A')
        expect(copy).toContain('Something odd')
        expect(copy).not.toMatch(/server/i)
        expect(describeFilesystemSaveFailure('not an error', 'A')).toMatch(/^Could not save “A”\./)
    })
})
