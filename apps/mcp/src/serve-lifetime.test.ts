import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { bindServeLifetime, type ServeEnd } from './serve-lifetime'

/**
 * What ends a `serve`, and that whichever comes first ends it once. The MCP shutdown sequence
 * for a stdio server is: the client closes the server's stdin, waits for it to exit, and only
 * then escalates to SIGTERM and SIGKILL - so EOF on stdin after a client has spoken must end
 * the process by itself, or every client waits out its grace period and signals (0.7.0, seen
 * from Windows 11, 2026-09-21). EOF before any client has spoken is not an end:
 * `serve … </dev/null &` keeps a store current with no agent attached.
 */
function harness() {
    const signals = new EventEmitter()
    const stdin = new EventEmitter()
    let transportClosed: (() => void) | undefined
    const ends: ServeEnd[] = []
    const shutdown = bindServeLifetime({
        signals,
        stdin,
        transportClosed: (listener) => {
            transportClosed = listener
        },
        shutdown: async (end) => {
            ends.push(end)
        },
    })
    return { signals, stdin, closeTransport: () => transportClosed?.(), ends, shutdown }
}

describe('a serve ends', () => {
    it('when the client closes stdin after speaking: the MCP shutdown sequence', async () => {
        const h = harness()
        h.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'))
        h.stdin.emit('end')
        await Promise.resolve()
        expect(h.ends).toEqual(['the client closed stdin'])
    })

    it('not when stdin is at EOF before any client spoke: serve </dev/null keeps a store current with no agent', async () => {
        const h = harness()
        h.stdin.emit('end')
        await Promise.resolve()
        expect(h.ends).toEqual([])
        // Later ends still count.
        h.signals.emit('SIGTERM')
        expect(h.ends).toEqual(['SIGTERM'])
    })

    it('on SIGINT, SIGTERM and the transport closing', () => {
        for (const [end, fire] of [
            ['SIGINT', (h: ReturnType<typeof harness>) => h.signals.emit('SIGINT')],
            ['SIGTERM', (h: ReturnType<typeof harness>) => h.signals.emit('SIGTERM')],
            ['the transport closed', (h: ReturnType<typeof harness>) => h.closeTransport()],
        ] as const) {
            const h = harness()
            fire(h)
            expect(h.ends).toEqual([end])
        }
    })

    it('once, whichever end comes first and however many arrive', async () => {
        const h = harness()
        h.stdin.emit('data', Buffer.from('x'))
        const first = h.shutdown('SIGTERM')
        h.stdin.emit('end')
        h.closeTransport()
        h.signals.emit('SIGINT')
        expect(h.shutdown('SIGINT')).toBe(first)
        await first
        expect(h.ends).toEqual(['SIGTERM'])
    })
})
