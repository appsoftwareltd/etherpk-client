import { describe, expect, it } from 'vitest'

import { describeChosenFolderFailure, describeFolderOpenFailure } from './folder-open-copy'

describe('describeFolderOpenFailure', () => {
    const copyFor = (name: string, message = 'x') => describeFolderOpenFailure(new DOMException(message, name))

    it('says the graph did not open, whatever the cause', () => {
        for (const name of ['NotFoundError', 'NotAllowedError', 'SecurityError', 'NoModificationAllowedError', 'NotReadableError', 'QuotaExceededError']) {
            expect(copyFor(name)).toMatch(/^Could not open the graph\. /)
        }
    })

    it('sends a moved folder to Forget and Open folder, and says the files are safe', () => {
        const copy = copyFor('NotFoundError')
        expect(copy).toContain('could not be found on disk')
        expect(copy).toContain('Forget the graph')
        expect(copy).toContain('your files are untouched')
        expect(copy).toContain('Open folder')
    })

    it('sends a lapsed permission to Try again, which holds the gesture the browser needs', () => {
        for (const name of ['NotAllowedError', 'SecurityError']) {
            expect(copyFor(name)).toContain('no longer lets EtherPK use this graph’s folder')
            expect(copyFor(name)).toContain('Try again')
        }
    })

    it('names the other program when a file in the folder is held by one', () => {
        expect(copyFor('NoModificationAllowedError')).toContain('locked by another program')
        expect(copyFor('NotReadableError')).toContain('could not be read')
    })

    it('reads browser storage faults as browser storage, since an open also uses it', () => {
        expect(copyFor('QuotaExceededError')).toContain('run out of storage')
        expect(copyFor('InvalidStateError', 'The database connection is closing.')).toContain('Reload the page')
    })

    it('falls back to the browser’s own message without doubling its full stop', () => {
        const copy = describeFolderOpenFailure(new Error('Something odd happened.'))
        expect(copy).toBe('Could not open the graph. The browser reported: Something odd happened. Try again, and reload the page if it keeps happening.')
    })

    it('still gives a next step when there is nothing to report', () => {
        expect(describeFolderOpenFailure('not an error')).toBe('Could not open the graph. Try again, and reload the page if it keeps happening.')
        expect(describeFolderOpenFailure(new Error(''))).toBe('Could not open the graph. Try again, and reload the page if it keeps happening.')
    })

    it('never blames a sync server, because a folder graph has none', () => {
        const faults = [
            new DOMException('x', 'NotFoundError'),
            new DOMException('x', 'NotAllowedError'),
            new DOMException('x', 'SecurityError'),
            new DOMException('x', 'NoModificationAllowedError'),
            new DOMException('x', 'NotReadableError'),
            new DOMException('x', 'QuotaExceededError'),
            new DOMException('The database connection is closing.', 'InvalidStateError'),
            new TypeError('Failed to fetch'),
            new Error('Something odd'),
            'not an error',
        ]
        for (const fault of faults) expect(describeFolderOpenFailure(fault)).not.toMatch(/server/i)
    })

    it('in an installed app names no browser, and says to choose the folder where permission is gone', () => {
        for (const name of ['NotFoundError', 'NotAllowedError', 'SecurityError', 'NoModificationAllowedError', 'NotReadableError', 'OperationError']) {
            expect([name, describeFolderOpenFailure(new DOMException('x', name), true)]).not.toEqual([name, expect.stringMatching(/browser/i)])
        }
        expect(describeFolderOpenFailure(new DOMException('x', 'NotAllowedError'), true)).toContain('choose the folder')
    })
})

describe('describeChosenFolderFailure', () => {
    const copyFor = (name: string, installed = false, message = 'x') => describeChosenFolderFailure(new DOMException(message, name), installed)

    it('says the folder did not open, and names no graph', () => {
        for (const name of ['NotFoundError', 'NotAllowedError', 'SecurityError', 'NoModificationAllowedError', 'NotReadableError', 'OperationError']) {
            expect(copyFor(name)).toMatch(/^Could not open that folder\. /)
            expect(copyFor(name)).not.toMatch(/graph/i)
        }
    })

    it('asks for the folder again when it is gone or access was refused', () => {
        expect(copyFor('NotFoundError')).toContain('could not be found on disk')
        expect(copyFor('NotAllowedError')).toContain('allow access if the browser asks')
        expect(copyFor('NotAllowedError', true)).not.toContain('browser')
        for (const name of ['NotFoundError', 'NotAllowedError']) expect(copyFor(name)).toContain('Choose the folder again')
    })

    it('reports what an unknown fault said, as the system in an installed app', () => {
        expect(copyFor('OperationError', true, 'The disk is offline.')).toContain('The system reported: The disk is offline.')
    })
})
