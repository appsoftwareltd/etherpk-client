import { describe, expect, it } from 'vitest'
import { failureOf, isFault, NativeFailure } from './failure.ts'

const systemError = (code: string) => Object.assign(new Error(`${code}: something, open '/home/someone/Notes/.etherpk-ab12.crswap'`), { code })

describe('a failure the page is told of', () => {
    it('has its name and a plain sentence, and never the path the system named', () => {
        for (const code of ['ENOENT', 'EACCES', 'EIO', 'ENOSPC', 'EEXIST', 'EWHATEVER']) {
            const failure = failureOf(systemError(code))
            expect(failure.message).not.toContain('/home/')
            expect(failure.message).not.toContain(code)
        }
        expect(failureOf(systemError('ENOSPC'))).toMatchObject({ failure: 'QuotaExceededError', message: 'The disk is full.' })
        expect(failureOf(systemError('EWHATEVER'))).toMatchObject({ failure: 'OperationError' })
    })
    it('keeps the shell’s own words, which name no path', () => {
        expect(failureOf(new NativeFailure('SecurityError', 'The path leads out of the folder.')).message).toBe('The path leads out of the folder.')
    })
    it('is logged when it is a fault, and not when it is an ordinary answer', () => {
        for (const code of ['EIO', 'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EBUSY']) expect(isFault(systemError(code))).toBe(true)
        for (const code of ['ENOENT', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY']) expect(isFault(systemError(code))).toBe(false)
        expect(isFault(new Error('no code'))).toBe(true)
        expect(isFault(new NativeFailure('NotFoundError', 'Nothing is there.'))).toBe(false)
        expect(isFault(new NativeFailure('OperationError', 'It did not work.'))).toBe(true)
    })
})
