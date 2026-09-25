import { describe, expect, it, vi } from 'vitest'
import {
    GraphSessionCancelledError,
    createGraphSession,
} from './graph-session'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

describe('GraphSession', () => {
    it('prevents an older open attempt publishing after a newer attempt starts', async () => {
        const session = createGraphSession('graph-a')
        const slow = deferred<string>()
        const first = session.beginOpen()
        const waiting = first.wait(slow.promise)

        session.beginOpen()
        slow.resolve('old')

        await expect(waiting).rejects.toBeInstanceOf(GraphSessionCancelledError)
        expect(first.isCurrent()).toBe(false)
    })

    it('owns resources and disposes each exactly once', async () => {
        const session = createGraphSession('graph-a')
        const disposeA = vi.fn()
        const disposeB = vi.fn(async () => {})
        session.own(disposeA)
        session.own(disposeB)

        await Promise.all([session.dispose(), session.dispose()])

        expect(disposeA).toHaveBeenCalledOnce()
        expect(disposeB).toHaveBeenCalledOnce()
    })

    it('disposes uncommitted candidates when an open is superseded', async () => {
        const session = createGraphSession('graph-a')
        const release = vi.fn()
        const first = session.beginOpen()
        first.own(release)

        session.beginOpen()

        expect(release).toHaveBeenCalledOnce()
        await session.dispose()
    })

    it('serialises presenter transitions and cancels queued work after disposal', async () => {
        const session = createGraphSession('graph-a')
        const firstGate = deferred<void>()
        const order: string[] = []
        const first = session.transitionPresenter(async () => {
            order.push('first-start')
            await firstGate.promise
            order.push('first-end')
        })
        const second = session.transitionPresenter(async () => {
            order.push('second')
        })
        firstGate.resolve()
        await Promise.all([first, second])
        expect(order).toEqual(['first-start', 'first-end', 'second'])

        await session.dispose()
        await expect(session.transitionPresenter(async () => {})).rejects.toBeInstanceOf(
            GraphSessionCancelledError,
        )
    })
})
