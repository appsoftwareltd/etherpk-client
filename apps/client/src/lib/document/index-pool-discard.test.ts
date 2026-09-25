import { afterEach, describe, expect, it, vi } from 'vitest'

import { discardIndexPool } from './index-pool-discard'
import { indexPoolDirectoryName } from './index-pool-names'

/** A minimal OPFS root: `removeEntry` scripted per call, everything else unused. */
function fakeRoot(script: Array<Error | null>) {
    const calls: Array<[string, unknown]> = []
    const root = {
        removeEntry: vi.fn(async (name: string, options: unknown) => {
            calls.push([name, options])
            const next = script.shift()
            if (next) throw next
        }),
    } as unknown as FileSystemDirectoryHandle
    return { root, calls }
}

function domException(name: string): Error {
    const error = new Error(name)
    error.name = name
    return error
}

describe('discardIndexPool', () => {
    const originalNavigator = globalThis.navigator

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
    })

    function withoutLocks() {
        Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    }

    it('removes the dot-prefixed pool directory recursively', async () => {
        withoutLocks()
        const { root, calls } = fakeRoot([null])
        const result = await discardIndexPool('g1', { root: async () => root })
        expect(result).toEqual({ kind: 'discarded' })
        expect(calls).toEqual([[indexPoolDirectoryName('g1'), { recursive: true }]])
        expect(indexPoolDirectoryName('g1')).toBe('.etherpk-index-g1')
    })

    it('treats a missing directory as already discarded', async () => {
        withoutLocks()
        const { root } = fakeRoot([domException('NotFoundError')])
        await expect(discardIndexPool('g1', { root: async () => root })).resolves.toEqual({ kind: 'discarded' })
    })

    it('retries a contention error until the handles are released', async () => {
        withoutLocks()
        const { root, calls } = fakeRoot([domException('NoModificationAllowedError'), null])
        let clock = 0
        const result = await discardIndexPool('g1', {
            root: async () => root,
            now: () => clock,
            sleep: async () => {
                clock += 250
            },
        })
        expect(result).toEqual({ kind: 'discarded' })
        expect(calls).toHaveLength(2)
    })

    it('rethrows a contention error once the deadline has passed', async () => {
        withoutLocks()
        const { root } = fakeRoot([domException('NoModificationAllowedError')])
        await expect(
            discardIndexPool('g1', { root: async () => root, timeoutMs: 0, now: () => 5 }),
        ).rejects.toThrow('NoModificationAllowedError')
    })

    it('rethrows anything that is not contention or absence', async () => {
        withoutLocks()
        const { root } = fakeRoot([domException('SecurityError')])
        await expect(discardIndexPool('g1', { root: async () => root })).rejects.toThrow('SecurityError')
    })

    it('answers held, deleting nothing, when the pool-lifetime lock never frees up', async () => {
        const request = vi.fn((_name: string, options: { signal: AbortSignal }, _body: () => Promise<void>) => {
            return new Promise<void>((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(domException('AbortError')))
            })
        })
        Object.defineProperty(globalThis, 'navigator', { value: { locks: { request } }, configurable: true })
        const { root, calls } = fakeRoot([null])
        const result = await discardIndexPool('g1', { root: async () => root, timeoutMs: 5 })
        expect(result).toEqual({ kind: 'held' })
        expect(calls).toHaveLength(0)
        expect(request.mock.calls[0]?.[0]).toBe('etherpk-index-pool-lifetime:g1')
    })

    it('runs the deletion inside the pool-lifetime lock when it is free', async () => {
        const request = vi.fn(async (_name: string, _options: unknown, body: () => Promise<void>) => body())
        Object.defineProperty(globalThis, 'navigator', { value: { locks: { request } }, configurable: true })
        const { root, calls } = fakeRoot([null])
        await expect(discardIndexPool('g1', { root: async () => root })).resolves.toEqual({ kind: 'discarded' })
        expect(calls).toHaveLength(1)
    })
})
