import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IndexTransport } from './client'
import type { IndexRequest, IndexResponse } from './protocol'
import { createSharedIndexTransport } from './share'

type MessageListener = (event: MessageEvent) => void

/** Minimal linked MessagePort used to observe both ends of a ferried candidate. */
class FakePort {
    readonly received: unknown[] = []
    readonly sent: unknown[] = []
    onmessage: MessageListener | null = null
    peer: FakePort | undefined
    closed = false
    private readonly listeners = new Map<string, Set<(event: Event) => void>>()

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const callback =
            typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
        let listeners = this.listeners.get(type)
        if (!listeners) {
            listeners = new Set()
            this.listeners.set(type, listeners)
        }
        listeners.add(callback)
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const listeners = this.listeners.get(type)
        if (!listeners || typeof listener !== 'function') return
        listeners.delete(listener)
    }

    postMessage(message: unknown, transfer: unknown[] = []): void {
        this.sent.push(message)
        const target = this.peer
        queueMicrotask(() => target?.receive(message, transfer))
    }

    start(): void {}

    close(): void {
        this.closed = true
    }

    receive(message: unknown, ports: unknown[] = []): void {
        this.received.push(message)
        const event = { data: message, ports } as unknown as MessageEvent
        this.onmessage?.(event)
        for (const listener of this.listeners.get('message') ?? []) listener(event)
    }
}

class FakeMessageChannel {
    readonly port1 = new FakePort()
    readonly port2 = new FakePort()

    constructor() {
        this.port1.peer = this.port2
        this.port2.peer = this.port1
    }
}

/** The asking tab's connection to the one broker SharedWorker. */
class FakeBrokerPort {
    readonly candidates: FakePort[] = []
    readonly sent: unknown[] = []
    onmessage: MessageListener | null = null

    addEventListener(): void {}
    removeEventListener(): void {}
    start(): void {}
    close(): void {}

    postMessage(message: unknown, transfer: unknown[] = []): void {
        this.sent.push(message)
        if ((message as { type?: string }).type === 'connect' && transfer[0] instanceof FakePort) {
            // The broker has accepted the remote endpoint and keeps it live, but the owner
            // deliberately does not answer until the test says so.
            this.candidates.push(transfer[0])
        }
    }
}

class FakeDedicatedWorker {
    readonly sent: unknown[] = []
    terminated = false
    private readonly listeners = new Map<string, Set<(event: Event) => void>>()

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const callback =
            typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event)
        let listeners = this.listeners.get(type)
        if (!listeners) {
            listeners = new Set()
            this.listeners.set(type, listeners)
        }
        listeners.add(callback)
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === 'function') this.listeners.get(type)?.delete(listener)
    }

    postMessage(message: unknown): void {
        this.sent.push(message)
    }

    terminate(): void {
        this.terminated = true
    }
}

interface FakeBrowser {
    broker: FakeBrokerPort
    workers: FakeDedicatedWorker[]
}

function installFakeBrowser(): FakeBrowser {
    const broker = new FakeBrokerPort()
    const workers: FakeDedicatedWorker[] = []

    const locks = {
        request(
            _name: string,
            options: { ifAvailable?: boolean },
            callback: (lock: null) => unknown,
        ): Promise<unknown> {
            if (options.ifAvailable) return Promise.resolve(callback(null))
            // A live owner keeps the queued takeover claim pending throughout each test.
            return new Promise(() => {})
        },
    }

    class SharedWorkerStub {
        readonly port = broker
    }

    class WorkerStub extends FakeDedicatedWorker {
        constructor() {
            super()
            workers.push(this)
        }
    }

    vi.stubGlobal('navigator', { locks })
    vi.stubGlobal('SharedWorker', SharedWorkerStub)
    vi.stubGlobal('Worker', WorkerStub)
    vi.stubGlobal('MessageChannel', FakeMessageChannel)

    return { broker, workers }
}

async function flushMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

const open: IndexRequest = { type: 'open', graphId: 'g1', openId: 41 }

describe('shared index follower ferry', () => {
    const transports: IndexTransport[] = []

    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        for (const transport of transports.splice(0)) transport.close()
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    function startFollower(): { transport: IndexTransport; browser: FakeBrowser } {
        const browser = installFakeBrowser()
        const transport = createSharedIndexTransport('g1')
        transports.push(transport)
        transport.onMessage((_response: IndexResponse) => {})
        transport.send(open)
        return { transport, browser }
    }

    it('keeps one live candidate instead of re-ferrying while its owner is silent', async () => {
        const { browser } = startFollower()
        await flushMicrotasks()

        // Several old 1.5-second retry intervals pass while the broker still holds the
        // first live candidate. Time passing is liveness accounting, not a reason to clone
        // another port and eager open into the same owner worker.
        await vi.advanceTimersByTimeAsync(7_500)
        await flushMicrotasks()

        expect(
            browser.broker.sent.filter(
                (message) => (message as { type?: string }).type === 'connect',
            ),
        ).toHaveLength(1)
        expect(browser.broker.candidates).toHaveLength(1)
        const eagerOpens = browser.broker.candidates.flatMap((candidate) =>
            candidate.received.filter(
                (message): message is IndexRequest =>
                    (message as IndexRequest).type === 'open',
            ),
        )
        expect(eagerOpens).toEqual([open])
    })

    it('does not replay an open which the adopted candidate already carries', async () => {
        const { browser } = startFollower()
        await flushMicrotasks()
        const candidate = browser.broker.candidates[0]
        expect(candidate).toBeDefined()
        expect(candidate?.received.filter((message) => (message as IndexRequest).type === 'open')).toEqual([
            open,
        ])

        // `attached` proves this exact endpoint was adopted. Its eager open was queued on
        // that endpoint before transfer, so swapping to it must not flush the same queued
        // request a second time.
        candidate?.postMessage({ type: 'attached' } satisfies IndexResponse)
        await flushMicrotasks()

        expect(candidate?.received.filter((message) => (message as IndexRequest).type === 'open')).toEqual([
            open,
        ])
    })

    it('configures temporary service as memory-only before sending its queued open', async () => {
        const { browser } = startFollower()
        await flushMicrotasks()

        // The owner lock is known to be held. Once ferry patience expires, a temporary
        // worker must skip the futile 12-second OPFS contention loop and serve memory-only.
        await vi.advanceTimersByTimeAsync(40_000)
        await flushMicrotasks()

        expect(browser.workers).toHaveLength(1)
        expect(browser.workers[0]?.sent.slice(0, 2)).toEqual([
            { type: 'configure-host', persistence: 'memory' },
            open,
        ])
    })
})
