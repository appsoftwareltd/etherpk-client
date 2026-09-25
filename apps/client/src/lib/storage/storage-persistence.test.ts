import { describe, expect, it, vi } from 'vitest'

import { ensurePersistentStorage } from './storage-persistence'

describe('ensurePersistentStorage', () => {
    it('reports an unsupported browser without touching anything', async () => {
        expect(await ensurePersistentStorage(undefined)).toEqual({
            supported: false,
            persisted: false,
            requested: false,
        })
    })

    it('does not re-request when the origin is already persistent', async () => {
        const persist = vi.fn()
        const outcome = await ensurePersistentStorage({ persisted: async () => true, persist })

        expect(outcome).toEqual({ supported: true, persisted: true, requested: false })
        expect(persist).not.toHaveBeenCalled()
    })

    it('requests persistence and reports the grant', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => true,
        })

        expect(outcome).toEqual({ supported: true, persisted: true, requested: true })
    })

    it('reports a refused request rather than assuming it succeeded', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => false,
        })

        expect(outcome).toEqual({ supported: true, persisted: false, requested: true })
    })

    it('treats a throwing StorageManager as not persisted, never as a startup failure', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => {
                throw new DOMException('denied', 'SecurityError')
            },
        })

        expect(outcome).toEqual({ supported: true, persisted: false, requested: true })
    })
})

describe('describeDeviceStorage', () => {
    it('reports an unsupported browser as unknown on every count', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        expect(await describeDeviceStorage(undefined)).toEqual({ supported: false, persisted: null, usage: null, quota: null })
    })

    it('reads persistence and the usage estimate', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        const report = await describeDeviceStorage({
            persisted: async () => true,
            estimate: async () => ({ usage: 1234, quota: 5678 }),
        })
        expect(report).toEqual({ supported: true, persisted: true, usage: 1234, quota: 5678 })
    })

    it('tolerates a StorageManager without estimate, or one that throws', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        expect(await describeDeviceStorage({ persisted: async () => false })).toEqual({
            supported: true,
            persisted: false,
            usage: null,
            quota: null,
        })
        expect(
            await describeDeviceStorage({
                persisted: async () => {
                    throw new DOMException('denied', 'SecurityError')
                },
                estimate: async () => {
                    throw new DOMException('denied', 'SecurityError')
                },
            }),
        ).toEqual({ supported: true, persisted: null, usage: null, quota: null })
    })
})
