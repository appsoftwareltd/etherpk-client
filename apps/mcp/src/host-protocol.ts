/**
 * What a client says to a graph host before anything else, and what the host answers: one line
 * of JSON each way (ADR 0072, amended 2026-10-08). A `session` is a `serve` relaying an agent's
 * MCP session, and after the host's `ok` the connection carries that session's MCP messages.
 * `status`, `stop` and `publish` are one request and one answer, from `running`, `stop`,
 * `login`, `logout` and `publish`.
 *
 * A client proves the host is the graph's own before it trusts the answer: it sends a random
 * nonce, and the host answers with an HMAC of it under the secret in its `host.json`, which only
 * this user can read. A Unix host listens where only this user can reach, but a Windows pipe name
 * is visible to every user of the computer, and another user's program could listen at a name a
 * host has left. With the proof, a client that reaches such a program finds out before it sends
 * the agent's calls.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import type { HostTarget } from './host-endpoint'

/**
 * Bumped when a request or an answer changes shape in a way an older host would misread. A host
 * answers a request in a protocol it does not speak with `unsupported`. `stop` and `stopping`
 * never change shape, so any version can ask any host to step aside.
 */
export const HOST_PROTOCOL = 1

export type HostRequest = (
    | {
          etherpk: 'session'
          protocol: number
          /** The relaying `serve`'s package version: a newer one asks an older host to step aside. */
          version: string
          /** The agent's registration passed --no-semantic: its search has no semantic mode. */
          noSemantic?: boolean
      }
    | { etherpk: 'status'; protocol: number }
    | { etherpk: 'stop'; protocol: number; reason: string }
    | {
          etherpk: 'publish'
          protocol: number
          publication: string
          /** `publish --out`: the folder to remember for this publication, absolute. */
          out?: string
          /** The command line's own settings for a publish, which may differ from the host's. */
          env: Record<string, string>
      }
) & {
    /** Random hex the host answers with `proof`, so the client knows it reached the graph's host. */
    nonce?: string
}

export interface HostStatus {
    pid: number
    version: string
    target: HostTarget
    startedAt: string
    /** What the graph is doing: still opening, open, or failed with the reason. */
    graph: { state: 'opening' | 'open' | 'failed'; name: string; message?: string }
    sessions: number
    /** It is flushing the graph and exiting. */
    stopping: boolean
}

export type HostReply = (
    /** A session is accepted; its MCP messages follow on the same connection. */
    | { etherpk: 'ok'; status: HostStatus }
    | { etherpk: 'status'; status: HostStatus }
    /** The host is flushing and exiting: a client tries again shortly, and then starts a new one. */
    | { etherpk: 'stopping' }
    /** The request failed or was not understood; the message says why. */
    | { etherpk: 'failed'; message: string }
    /** The host speaks another protocol: a different version of etherpk-mcp started it. */
    | { etherpk: 'unsupported'; protocol: number; version: string }
    /** `publish`: what the command prints, the lines it says on stderr, and its exit code. */
    | { etherpk: 'published'; output: unknown; notes: string[]; exitCode: number }
    /** `publish` refused, in the command line's words. */
    | { etherpk: 'refused'; message: string }
) & {
    /** The HMAC of the request's nonce under the host's secret; absent when the request had no nonce. */
    proof?: string
}

/** The host's answer to a nonce: an HMAC under the secret only it and this user's files hold. */
export function proofOf(secret: string, nonce: string): string {
    return createHmac('sha256', secret).update(nonce).digest('hex')
}

/** What answered at a host's endpoint could not prove it holds the graph's secret. */
export class HostImpostor extends Error {
    constructor(endpoint: string) {
        super(`Something answered at ${endpoint}, but it is not this graph's background process.`)
        this.name = 'HostImpostor'
    }
}

export function writeJsonLine(socket: Duplex, value: HostRequest | HostReply): void {
    socket.write(`${JSON.stringify(value)}\n`)
}

/**
 * Read one line of JSON from `socket`, then leave it paused with whatever followed the line put
 * back, for the next reader: the session's MCP transport, after a handshake.
 */
export function readJsonLine(socket: Duplex, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<unknown> {
    const maxBytes = options.maxBytes ?? 1024 * 1024
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0)
        let settled = false
        const finish = (error: Error | null, value?: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.off('data', onData)
            socket.off('error', onError)
            socket.off('close', onClose)
            if (error) reject(error)
            else resolve(value)
        }
        const timer = options.timeoutMs ? setTimeout(() => finish(new Error('No answer in time.')), options.timeoutMs) : undefined
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk])
            const end = buffered.indexOf(10)
            if (end === -1) {
                if (buffered.length > maxBytes) finish(new Error('The line was too long.'))
                return
            }
            socket.pause()
            const rest = buffered.subarray(end + 1)
            if (rest.length > 0) socket.unshift(rest)
            let value: unknown
            try {
                value = JSON.parse(buffered.subarray(0, end).toString('utf8'))
            } catch {
                finish(new Error('The line was not JSON.'))
                return
            }
            finish(null, value)
        }
        const onError = (error: Error) => finish(error)
        const onClose = () => finish(new Error('The connection closed before an answer.'))
        socket.on('data', onData)
        socket.on('error', onError)
        socket.on('close', onClose)
        socket.resume()
    })
}

/** Connect to a host's endpoint; rejects with the connection's own error (ENOENT, ECONNREFUSED). */
export function connectEndpoint(endpoint: string, timeoutMs = 5_000): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect(endpoint)
        const timer = setTimeout(() => {
            socket.destroy()
            reject(Object.assign(new Error(`No answer from ${endpoint}.`), { code: 'ETIMEDOUT' }))
        }, timeoutMs)
        socket.once('connect', () => {
            clearTimeout(timer)
            socket.off('error', reject)
            resolve(socket)
        })
        socket.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
    })
}

/**
 * One request to a host and its answer. The socket is returned open: for a `session` it goes on
 * to carry MCP, and for a `stop` its closing is the host's exit. The caller ends it otherwise.
 * Given the host's `secret`, the answer must prove it, or this rejects with `HostImpostor`.
 */
export async function hostRequest(endpoint: string, request: HostRequest, options: { timeoutMs?: number; secret?: string } = {}): Promise<{ reply: HostReply; socket: Socket }> {
    const socket = await connectEndpoint(endpoint)
    try {
        const nonce = options.secret ? randomBytes(16).toString('hex') : undefined
        writeJsonLine(socket, nonce ? { ...request, nonce } : request)
        const reply = (await readJsonLine(socket, { timeoutMs: options.timeoutMs, maxBytes: 64 * 1024 * 1024 })) as HostReply
        if (options.secret && nonce) {
            const expected = Buffer.from(proofOf(options.secret, nonce), 'hex')
            const given = Buffer.from(typeof reply?.proof === 'string' ? reply.proof : '', 'hex')
            if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HostImpostor(endpoint)
        }
        return { reply, socket }
    } catch (error) {
        socket.destroy()
        throw error
    }
}

/**
 * The settings a publish reads, which the command line decides even when the graph's host runs
 * the publish: where the publish folders are remembered, and which browser draws diagrams. The
 * host was started from another environment (an agent's), and a scheduled publish may name its
 * own browser.
 */
const PUBLISH_SETTINGS = ['ETHERPK_MCP_PUBLISH_CONFIG', 'XDG_CONFIG_HOME', 'ETHERPK_CHROMIUM', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE'] as const

/** The publish settings in `env`, for a `publish` request. */
export function publishSettings(env: NodeJS.ProcessEnv): Record<string, string> {
    const picked: Record<string, string> = {}
    for (const name of PUBLISH_SETTINGS) {
        const value = env[name]
        if (value !== undefined) picked[name] = value
    }
    return picked
}

/** The host's environment with the command line's publish settings in place of its own, set or not. */
export function withPublishSettings(env: NodeJS.ProcessEnv, settings: Record<string, string>): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...env }
    for (const name of PUBLISH_SETTINGS) {
        if (typeof settings[name] === 'string') merged[name] = settings[name]
        else delete merged[name]
    }
    return merged
}

/**
 * Resolves once the connection has closed. Resumed first: a socket left paused after its answer
 * was read never sees the other end close, and never closes.
 */
export function whenClosed(socket: Socket): Promise<void> {
    return new Promise((resolve) => {
        if (socket.destroyed) {
            resolve()
            return
        }
        socket.once('close', () => resolve())
        socket.on('data', () => {})
        socket.resume()
    })
}

/** Is a semantic version newer than another? `0.10.0` is newer than `0.9.2`. */
export function newerVersion(candidate: string, than: string): boolean {
    const parts = (value: string) => value.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
    const [a, b] = [parts(candidate), parts(than)]
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i]
    }
    return false
}
