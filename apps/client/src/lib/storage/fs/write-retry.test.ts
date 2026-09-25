import { describe, expect, it, vi } from 'vitest'

import { TRANSIENT_WRITE_RETRY_MS, isTransientWriteFault, writeWithOneRetry } from './write-retry'

/** What Chrome reports when the rename of its swap file over the target is refused. */
const blocked = () =>
    new DOMException(
        'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
        'InvalidStateError',
    )

describe('writeWithOneRetry', () => {
    it('retries once, after the delay, when the browser could not replace the file', async () => {
        const sleep = vi.fn(async (_ms: number) => {})
        const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(blocked()).mockResolvedValueOnce('written')

        await expect(writeWithOneRetry(attempt, { sleep })).resolves.toBe('written')

        expect(attempt).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledTimes(1)
        expect(sleep).toHaveBeenCalledWith(TRANSIENT_WRITE_RETRY_MS)
    })

    it('does not retry any other fault', async () => {
        const sleep = vi.fn(async (_ms: number) => {})
        const full = new DOMException('The disk is full.', 'QuotaExceededError')
        const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(full)

        await expect(writeWithOneRetry(attempt, { sleep })).rejects.toBe(full)

        expect(attempt).toHaveBeenCalledTimes(1)
        expect(sleep).not.toHaveBeenCalled()
    })

    it('gives up after the second failure and surfaces it as it is', async () => {
        const sleep = vi.fn(async (_ms: number) => {})
        const again = blocked()
        const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(blocked()).mockRejectedValueOnce(again)

        await expect(writeWithOneRetry(attempt, { sleep })).rejects.toBe(again)

        expect(attempt).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledTimes(1)
    })

    it('neither sleeps nor retries when the first attempt succeeds', async () => {
        const sleep = vi.fn(async (_ms: number) => {})
        const attempt = vi.fn<() => Promise<string>>().mockResolvedValue('written')

        await expect(writeWithOneRetry(attempt, { sleep })).resolves.toBe('written')

        expect(attempt).toHaveBeenCalledTimes(1)
        expect(sleep).not.toHaveBeenCalled()
    })
})

describe('isTransientWriteFault', () => {
    it('is the InvalidStateError name and nothing else', () => {
        expect(isTransientWriteFault(blocked())).toBe(true)
        expect(isTransientWriteFault(new DOMException('x', 'NotFoundError'))).toBe(false)
        expect(isTransientWriteFault(new Error('InvalidStateError'))).toBe(false)
        expect(isTransientWriteFault('InvalidStateError')).toBe(false)
    })
})
