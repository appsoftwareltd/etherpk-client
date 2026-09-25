import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sqliteMocks = vi.hoisted(() => ({
    init: vi.fn(),
    install: vi.fn(),
    wrap: vi.fn(),
}))

vi.mock('@sqlite.org/sqlite-wasm', () => ({
    default: sqliteMocks.init,
}))

vi.mock('./index-db-sqlite', () => ({
    wrapOo1Db: sqliteMocks.wrap,
}))

import { openPersistedSqlDb, persistenceBlockFor } from './index-db-opfs'

const POOL_PREFIX = 'etherpk-index-'

function heldAccessHandleError(): DOMException {
    return new DOMException(
        'Access Handles cannot be created while another context holds this file.',
        'NoModificationAllowedError',
    )
}

/**
 * Model the small, read-only part of OPFS needed to tell whether an existing SAH pool is
 * still held. SQLite synthesises `.<vfs name>/.opaque`; acquiring every opaque slot together
 * lets a successor wait without asking sqlite-wasm to initialise (and clean up) the whole VFS.
 */
function stubExistingPool(
    graphId: string,
    createSyncAccessHandles: Array<ReturnType<typeof vi.fn>>,
): void {
    const slots = createSyncAccessHandles.map((createSyncAccessHandle) => ({
        kind: 'file',
        createSyncAccessHandle,
    }))
    const entries = async function* () {
        for (const [index, slot] of slots.entries()) yield [`slot-${index + 1}`, slot] as const
    }
    const values = async function* () {
        yield* slots
    }
    const opaqueDirectory = {
        entries,
        values,
        [Symbol.asyncIterator]: entries,
    }
    const poolDirectory = {
        getDirectoryHandle: vi.fn(async (name: string) => {
            if (name !== '.opaque') throw new DOMException('not found', 'NotFoundError')
            return opaqueDirectory
        }),
    }
    const root = {
        getDirectoryHandle: vi.fn(async (name: string) => {
            if (name !== `.${POOL_PREFIX}${graphId}`) {
                throw new DOMException('not found', 'NotFoundError')
            }
            return poolDirectory
        }),
    }

    vi.stubGlobal('navigator', {
        storage: {
            getDirectory: vi.fn(async () => root),
        },
    })
}

function stubAppearingPool(
    graphId: string,
    createSyncAccessHandle: ReturnType<typeof vi.fn>,
): void {
    const opaqueDirectory = {
        values: async function* () {
            yield { kind: 'file', createSyncAccessHandle }
        },
    }
    const poolDirectory = {
        getDirectoryHandle: vi.fn(async (name: string) => {
            if (name !== '.opaque') throw new DOMException('not found', 'NotFoundError')
            return opaqueDirectory
        }),
    }
    const root = {
        getDirectoryHandle: vi
            .fn()
            // A predecessor can have passed its own root lookup immediately before its page
            // released the owner lock, then create the directory while the successor waits.
            .mockRejectedValueOnce(new DOMException('not found', 'NotFoundError'))
            .mockImplementation(async (name: string) => {
                if (name !== `.${POOL_PREFIX}${graphId}`) {
                    throw new DOMException('not found', 'NotFoundError')
                }
                return poolDirectory
            }),
    }

    vi.stubGlobal('navigator', {
        storage: {
            getDirectory: vi.fn(async () => root),
        },
    })
}

function installablePool() {
    class FakeOpfsDb {}

    return {
        getFileCount: vi.fn(() => 1),
        reserveMinimumCapacity: vi.fn(async () => undefined),
        OpfsSAHPoolDb: FakeOpfsDb,
    }
}

describe('OPFS index takeover', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        sqliteMocks.init.mockReset()
        sqliteMocks.install.mockReset()
        sqliteMocks.wrap.mockReset()

        sqliteMocks.init.mockResolvedValue({
            installOpfsSAHPoolVfs: sqliteMocks.install,
        })
        sqliteMocks.install.mockResolvedValue(installablePool())
        sqliteMocks.wrap.mockReturnValue({
            exec: vi.fn(),
            run: vi.fn(),
            all: vi.fn(() => [{ n: 1 }]),
            close: vi.fn(),
        })
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('waits for the old access handle before installing the SQLite VFS exactly once', async () => {
        const graphId = '11111111-1111-4111-8111-takeover-probe'
        const firstSlotClose = vi.fn()
        const secondSlotClose = vi.fn()
        const firstSlot = vi.fn().mockImplementation(async () => ({ close: firstSlotClose }))
        const secondSlot = vi
            .fn()
            .mockRejectedValueOnce(heldAccessHandleError())
            .mockRejectedValueOnce(heldAccessHandleError())
            .mockRejectedValueOnce(heldAccessHandleError())
            .mockResolvedValue({ close: secondSlotClose })
        stubExistingPool(graphId, [firstSlot, secondSlot])

        const opening = openPersistedSqlDb(graphId)
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(opening).resolves.not.toBeNull()
        // A partially released pool is still held. Each unsuccessful probe closes the
        // earlier slot it acquired, and installation waits until every slot is available.
        expect(firstSlot).toHaveBeenCalledTimes(4)
        expect(secondSlot).toHaveBeenCalledTimes(4)
        expect(firstSlotClose).toHaveBeenCalledTimes(4)
        expect(secondSlotClose).toHaveBeenCalledOnce()
        expect(sqliteMocks.install).toHaveBeenCalledOnce()
        expect(sqliteMocks.install).not.toHaveBeenCalledWith(
            expect.objectContaining({ forceReinitIfPreviouslyFailed: true }),
        )
    })

    it('reports a held pool without invoking the destructive SQLite installer when contention persists', async () => {
        const graphId = '22222222-2222-4222-8222-takeover-timeout'
        const createSyncAccessHandle = vi.fn().mockRejectedValue(heldAccessHandleError())
        stubExistingPool(graphId, [createSyncAccessHandle])

        const opening = openPersistedSqlDb(graphId)
        await vi.advanceTimersByTimeAsync(12_500)

        await expect(opening).resolves.toBeNull()
        expect(createSyncAccessHandle.mock.calls.length).toBeGreaterThan(1)
        expect(sqliteMocks.install).not.toHaveBeenCalled()
        expect(persistenceBlockFor(graphId)).toBe('held')
    })

    it('does not install while a predecessor creates and briefly holds a previously missing pool', async () => {
        const graphId = '33333333-3333-4333-8333-appearing-pool'
        const close = vi.fn()
        const createSyncAccessHandle = vi
            .fn()
            .mockRejectedValueOnce(heldAccessHandleError())
            .mockResolvedValue({ close })
        stubAppearingPool(graphId, createSyncAccessHandle)

        const opening = openPersistedSqlDb(graphId)
        await vi.advanceTimersByTimeAsync(1_000)

        await expect(opening).resolves.not.toBeNull()
        expect(createSyncAccessHandle).toHaveBeenCalledTimes(2)
        expect(close).toHaveBeenCalledOnce()
        expect(sqliteMocks.install).toHaveBeenCalledOnce()
        expect(sqliteMocks.init.mock.invocationCallOrder[0]).toBeLessThan(
            createSyncAccessHandle.mock.invocationCallOrder[0]!,
        )
    })

    it('queues behind the predecessor worker lifetime lock before probing or installing', async () => {
        const graphId = '44444444-4444-4444-8444-worker-lifetime-lock'
        const close = vi.fn()
        const createSyncAccessHandle = vi.fn().mockResolvedValue({ close })
        stubExistingPool(graphId, [createSyncAccessHandle])

        let grant!: () => void
        const request = vi.fn(
            (
                _name: string,
                _options: { signal: AbortSignal },
                callback: () => Promise<void>,
            ) =>
                new Promise<void>((resolve, reject) => {
                    grant = () => {
                        void callback().then(resolve, reject)
                    }
                }),
        )
        vi.stubGlobal('navigator', {
            storage: navigator.storage,
            locks: { request },
        })

        const opening = openPersistedSqlDb(graphId)
        await vi.advanceTimersByTimeAsync(500)

        expect(sqliteMocks.init).toHaveBeenCalledOnce()
        expect(createSyncAccessHandle).not.toHaveBeenCalled()
        expect(sqliteMocks.install).not.toHaveBeenCalled()

        grant()
        await vi.advanceTimersByTimeAsync(500)
        await expect(opening).resolves.not.toBeNull()
        expect(request).toHaveBeenCalledWith(
            `etherpk-index-pool-lifetime:${graphId}`,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
            expect.any(Function),
        )
        expect(createSyncAccessHandle).toHaveBeenCalledOnce()
        expect(sqliteMocks.install).toHaveBeenCalledOnce()
    })

    it('reports held without probing or installing when the predecessor worker lock outlives the window', async () => {
        const graphId = '55555555-5555-4555-8555-worker-lock-timeout'
        const createSyncAccessHandle = vi.fn()
        stubExistingPool(graphId, [createSyncAccessHandle])

        const request = vi.fn(
            (_name: string, options: { signal: AbortSignal }, _callback: () => Promise<void>) =>
                new Promise<void>((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        reject(new DOMException('aborted', 'AbortError'))
                    })
                }),
        )
        vi.stubGlobal('navigator', {
            storage: navigator.storage,
            locks: { request },
        })

        const opening = openPersistedSqlDb(graphId)
        await vi.advanceTimersByTimeAsync(12_500)

        await expect(opening).resolves.toBeNull()
        expect(createSyncAccessHandle).not.toHaveBeenCalled()
        expect(sqliteMocks.install).not.toHaveBeenCalled()
        expect(persistenceBlockFor(graphId)).toBe('held')
    })
})
