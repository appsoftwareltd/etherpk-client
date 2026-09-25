import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from './event-bus'

describe('event bus', () => {
    it('delivers an emitted event to a registered listener, with graphId injected', () => {
        const bus = createEventBus('g1')
        const seen: unknown[] = []
        bus.on('documents:changed', (p) => seen.push(p))

        bus.emit('documents:changed', {})

        expect(seen).toEqual([{ graphId: 'g1' }])
    })

    it('injects the bus graphId into every payload (the scope is the bus, not the caller)', () => {
        const bus = createEventBus('private-graph')
        const seen: Array<{ graphId: string; documentId: string | null }> = []
        bus.on('document:active-changed', (p) => seen.push(p))

        bus.emit('document:active-changed', { documentId: 'Physics' })

        expect(seen).toEqual([{ graphId: 'private-graph', documentId: 'Physics' }])
    })

    it('calls listeners in registration order', () => {
        const bus = createEventBus('g1')
        const order: number[] = []
        bus.on('documents:changed', () => order.push(1))
        bus.on('documents:changed', () => order.push(2))
        bus.on('documents:changed', () => order.push(3))

        bus.emit('documents:changed', {})

        expect(order).toEqual([1, 2, 3])
    })

    it('delivers only to listeners of the emitted event', () => {
        const bus = createEventBus('g1')
        const docs = vi.fn()
        const active = vi.fn()
        bus.on('documents:changed', docs)
        bus.on('document:active-changed', active)

        bus.emit('documents:changed', {})

        expect(docs).toHaveBeenCalledTimes(1)
        expect(active).not.toHaveBeenCalled()
    })

    // The structural Event ≠ Hook guarantee: an observer cannot corrupt the
    // producer or its siblings. A throwing listener must neither stop the other
    // listeners nor escape emit().
    it('isolates a throwing listener: siblings still fire and emit does not throw', () => {
        const bus = createEventBus('g1')
        const before = vi.fn()
        const after = vi.fn()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        bus.on('documents:changed', before)
        bus.on('documents:changed', () => {
            throw new Error('observer blew up')
        })
        bus.on('documents:changed', after)

        expect(() => bus.emit('documents:changed', {})).not.toThrow()
        expect(before).toHaveBeenCalledTimes(1)
        expect(after).toHaveBeenCalledTimes(1)
        expect(consoleError).toHaveBeenCalled()
        consoleError.mockRestore()
    })

    it('on() returns a dispose fn that removes exactly that listener', () => {
        const bus = createEventBus('g1')
        const a = vi.fn()
        const b = vi.fn()
        const disposeA = bus.on('documents:changed', a)
        bus.on('documents:changed', b)

        disposeA()
        bus.emit('documents:changed', {})

        expect(a).not.toHaveBeenCalled()
        expect(b).toHaveBeenCalledTimes(1)
    })

    it('double-dispose is safe and does not remove other listeners', () => {
        const bus = createEventBus('g1')
        const a = vi.fn()
        const b = vi.fn()
        const disposeA = bus.on('documents:changed', a)
        bus.on('documents:changed', b)

        disposeA()
        disposeA() // idempotent — must not throw or affect b

        bus.emit('documents:changed', {})
        expect(b).toHaveBeenCalledTimes(1)
    })

    it('emitting with no listeners is a no-op', () => {
        const bus = createEventBus('g1')
        expect(() => bus.emit('documents:changed', {})).not.toThrow()
    })
})
