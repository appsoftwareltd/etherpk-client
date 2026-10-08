/**
 * MCP over a local socket: the same newline-delimited JSON-RPC the stdio transport speaks, over
 * any duplex stream. The graph host (`graph-host.ts`) gives each session one of these on its
 * Unix socket or named pipe, and `etherpk-mcp publish` talks to a host through one.
 *
 * The SDK's `StdioServerTransport` reads a duplex too, but it never hears the other end leave: it
 * listens for `data` and `error` only, because a process's stdin ending is the process's business.
 * A host has many sessions and must notice each one closing, so this one reports `close`.
 */
import type { Duplex } from 'node:stream'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export class SocketTransport implements Transport {
    onclose?: () => void
    onerror?: (error: Error) => void
    onmessage?: (message: JSONRPCMessage) => void

    private readonly buffer = new ReadBuffer()
    private started = false
    private closed = false

    constructor(private readonly socket: Duplex) {}

    async start(): Promise<void> {
        if (this.started) throw new Error('SocketTransport already started')
        this.started = true
        this.socket.on('data', this.onData)
        this.socket.on('error', this.onError)
        this.socket.on('close', this.onSocketClose)
        // A socket paused while its handshake line was read flows again once read.
        this.socket.resume()
    }

    /**
     * Resolves once the message has been handed to the operating system, and rejects when it
     * could not be: the other end had already gone. The relay (`host-relay.ts`) sends a call that
     * was never handed over to the next host, and only that kind.
     */
    send(message: JSONRPCMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.closed || this.socket.destroyed) {
                reject(new Error('The connection is closed.'))
                return
            }
            this.socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()))
        })
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.socket.end()
        this.finish()
    }

    private readonly onData = (chunk: Buffer): void => {
        try {
            this.buffer.append(chunk)
        } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)))
            void this.close()
            return
        }
        for (;;) {
            let message: JSONRPCMessage | null
            try {
                message = this.buffer.readMessage()
            } catch (error) {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)))
                continue
            }
            if (message === null) break
            this.onmessage?.(message)
        }
    }

    private readonly onError = (error: Error): void => {
        this.onerror?.(error)
    }

    private readonly onSocketClose = (): void => {
        this.finish()
    }

    /** Stop reading and say so, once, however the connection ended. */
    private finish(): void {
        if (this.closed) return
        this.closed = true
        this.socket.off('data', this.onData)
        this.socket.off('error', this.onError)
        this.socket.off('close', this.onSocketClose)
        this.buffer.clear()
        this.onclose?.()
    }
}
