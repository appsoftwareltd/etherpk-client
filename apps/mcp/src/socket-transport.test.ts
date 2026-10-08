import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SocketTransport } from './socket-transport'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
    // Last in, first out: the sockets go before the server that is waiting for them to.
    for (const fn of cleanup.splice(0).reverse()) await fn()
})

/** Two ends of a real local socket. */
async function socketPair(): Promise<{ a: Socket; b: Socket }> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-socket-'))
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\etherpk-test-${Date.now()}-${Math.random()}` : join(dir, 's.sock')
    const accepted = new Promise<Socket>((resolve) => {
        const server: Server = createServer((socket) => resolve(socket))
        server.listen(path)
        cleanup.push(async () => {
            await new Promise<void>((done) => server.close(() => done()))
            await rm(dir, { recursive: true, force: true })
        })
    })
    const a = connect(path)
    await new Promise<void>((resolve) => a.once('connect', () => resolve()))
    const b = await accepted
    cleanup.push(async () => {
        a.destroy()
        b.destroy()
    })
    return { a, b }
}

describe('the socket transport', () => {
    it('carries JSON-RPC messages both ways, split and joined however the bytes arrive', async () => {
        const { a, b } = await socketPair()
        const left = new SocketTransport(a)
        const right = new SocketTransport(b)
        const received: unknown[] = []
        right.onmessage = (message) => received.push(message)
        await left.start()
        await right.start()

        await left.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
        // A message written in two pieces is read as one.
        a.write('{"jsonrpc":"2.0","method":"notifications/')
        a.write('initialized"}\n')

        await expect.poll(() => received).toEqual([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
        ])
    })

    it('says it closed when the other end goes away, once', async () => {
        const { a, b } = await socketPair()
        const transport = new SocketTransport(b)
        let closes = 0
        transport.onclose = () => closes++
        await transport.start()

        a.end()
        await expect.poll(() => closes).toBe(1)
        await transport.close()
        expect(closes).toBe(1)
    })

    // The relay sends a call to the next host only when it never reached this one.
    it('refuses a send once the other end has gone, rather than reporting it sent', async () => {
        const { a, b } = await socketPair()
        const transport = new SocketTransport(a)
        transport.onerror = () => {}
        await transport.start()
        const gone = new Promise((resolve) => b.once('close', resolve))
        b.destroy()
        await gone

        await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_page' } })).rejects.toThrow()
    })

    it('reads bytes that arrived before it started, once they are put back', async () => {
        const { a, b } = await socketPair()
        b.pause()
        a.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
        await new Promise((resolve) => setTimeout(resolve, 50))
        const early = b.read() as Buffer | null
        if (early) b.unshift(early)

        const transport = new SocketTransport(b)
        const received: unknown[] = []
        transport.onmessage = (message) => received.push(message)
        await transport.start()

        await expect.poll(() => received).toEqual([{ jsonrpc: '2.0', id: 7, method: 'ping' }])
    })
})
