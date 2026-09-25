import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    _resetShutdownRegistry,
    installShutdownSignalHandlers,
    registerShutdownTask,
    runShutdown,
} from './shutdown'

afterEach(() => {
    _resetShutdownRegistry()
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
})

describe('runShutdown', () => {
    it('runs phases in order: drain, then dispose, then flush', async () => {
        const order: string[] = []
        registerShutdownTask({ name: 'logs', phase: 'flush', run: () => { order.push('flush') } })
        registerShutdownTask({ name: 'sockets', phase: 'dispose', run: () => { order.push('dispose') } })
        registerShutdownTask({ name: 'http', phase: 'drain', run: () => { order.push('drain') } })

        await runShutdown()

        expect(order).toEqual(['drain', 'dispose', 'flush'])
    })

    it('awaits an async task before moving to the next phase', async () => {
        const order: string[] = []
        registerShutdownTask({
            name: 'http',
            phase: 'drain',
            run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
                order.push('drain settled')
            },
        })
        registerShutdownTask({ name: 'logs', phase: 'flush', run: () => { order.push('flush') } })

        await runShutdown()

        expect(order).toEqual(['drain settled', 'flush'])
    })

    it('still flushes when an earlier task throws', async () => {
        const flushed = vi.fn()
        const onError = vi.fn()
        registerShutdownTask({ name: 'http', phase: 'drain', run: () => { throw new Error('boom') } })
        registerShutdownTask({ name: 'logs', phase: 'flush', run: flushed })

        await runShutdown({ onError })

        expect(flushed).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith('shutdown task failed', expect.objectContaining({ task: 'http' }))
    })

    it('does not let a hung task hold the process open past its budget', async () => {
        const flushed = vi.fn()
        const onError = vi.fn()
        registerShutdownTask({ name: 'http', phase: 'drain', run: () => new Promise<void>(() => {}) })
        registerShutdownTask({ name: 'logs', phase: 'flush', run: flushed })

        await runShutdown({ timeoutMs: 20, onError })

        expect(onError).toHaveBeenCalledWith('shutdown phase timed out', expect.objectContaining({ phase: 'drain' }))
        expect(flushed).toHaveBeenCalledOnce()
    })

    it('is idempotent, so a second signal joins the shutdown already running', async () => {
        const run = vi.fn()
        registerShutdownTask({ name: 'logs', phase: 'flush', run })

        await Promise.all([runShutdown(), runShutdown()])

        expect(run).toHaveBeenCalledOnce()
    })

    it('unregisters a task through the returned disposer', async () => {
        const run = vi.fn()
        const dispose = registerShutdownTask({ name: 'logs', phase: 'flush', run })
        dispose()

        await runShutdown()

        expect(run).not.toHaveBeenCalled()
    })
})

describe('installShutdownSignalHandlers', () => {
    it('installs once however many bundles ask, so no listener can exit early', () => {
        expect(installShutdownSignalHandlers({ onComplete: () => {} })).toBe(true)
        expect(installShutdownSignalHandlers({ onComplete: () => {} })).toBe(false)
        expect(process.listenerCount('SIGTERM')).toBe(1)
        expect(process.listenerCount('SIGINT')).toBe(1)
    })

    it('completes only after every registered task has finished', async () => {
        const order: string[] = []
        registerShutdownTask({
            name: 'logs',
            phase: 'flush',
            run: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
                order.push('flushed')
            },
        })
        const complete = new Promise<void>((resolve) => {
            installShutdownSignalHandlers({ onComplete: () => { order.push('exit'); resolve() } })
        })

        process.emit('SIGTERM')
        await complete

        expect(order).toEqual(['flushed', 'exit'])
    })
})
