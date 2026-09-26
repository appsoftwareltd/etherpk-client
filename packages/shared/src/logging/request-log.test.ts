import { describe, expect, it, vi } from 'vitest'
import type { RequestEvent } from '@sveltejs/kit'
import { createHandleError, logRequest, requestLogLevel } from './request-log'

function appLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function requestEvent(url: string, init: { method?: string; address?: string | Error } = {}): RequestEvent {
    return {
        request: new Request(url, { method: init.method ?? 'GET', headers: { 'user-agent': 'test-agent' } }),
        url: new URL(url),
        getClientAddress: () => {
            if (init.address instanceof Error) throw init.address
            return init.address ?? '203.0.113.9'
        },
        locals: {},
    } as unknown as RequestEvent
}

describe('requestLogLevel', () => {
    it('keeps a failure at error and a rate-limit refusal at warn', () => {
        expect(requestLogLevel('GET', '/api/x', 500)).toBe('error')
        expect(requestLogLevel('GET', '/api/x', 503)).toBe('error')
        expect(requestLogLevel('POST', '/api/auth/sign-in/email', 429)).toBe('warn')
    })

    it('writes ordinary refusals at info, where they are visible but raise no alert', () => {
        // A 404 from a bot, a 401 from a signed-out tab: routine, not something an operator acts on.
        expect(requestLogLevel('GET', '/favicon.ico', 404)).toBe('info')
        expect(requestLogLevel('GET', '/api/v1/sync/me', 401)).toBe('info')
        expect(requestLogLevel('POST', '/api/v1/sync/invites', 403)).toBe('info')
    })

    it('drops the health probe to debug, since it runs every few seconds', () => {
        expect(requestLogLevel('GET', '/health', 200)).toBe('debug')
        expect(requestLogLevel('GET', '/health', 503)).toBe('error')
        expect(requestLogLevel('GET', '/account', 200)).toBe('info')
    })
})

describe('logRequest', () => {
    it('writes one structured line with the path and query redacted', async () => {
        const logger = appLogger()
        const event = requestEvent('https://sync.test/api/auth/reset-password/Xk2pQ9?callbackURL=/reset&token=abc')
        await logRequest({ logger, hostname: 'pod-1' }, event, new Response(null, { status: 302, headers: { location: '/reset-password?token=abc' } }), {
            durationMs: 12.4,
            userId: 'user-1',
        })

        expect(logger.info).toHaveBeenCalledWith('HTTP request', expect.objectContaining({
            method: 'GET',
            path: '/api/auth/reset-password/[redacted]',
            query: '?callbackURL=/reset&token=[redacted]',
            location: '/reset-password?token=[redacted]',
            status: 302,
            duration_ms: 12,
            ip: '203.0.113.9',
            userAgent: 'test-agent',
            userId: 'user-1',
            hostname: 'pod-1',
        }))
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('Xk2pQ9')
    })

    it('captures an API error body for diagnosis, but never a better-auth one', async () => {
        const logger = appLogger()
        await logRequest(
            { logger, hostname: 'pod-1' },
            requestEvent('https://sync.test/api/v1/sync/graphs', { method: 'POST' }),
            Response.json({ error: { message: 'graphId required' } }, { status: 400 }),
            { durationMs: 1 },
        )
        await logRequest(
            { logger, hostname: 'pod-1' },
            requestEvent('https://sync.test/api/auth/sign-in/email', { method: 'POST' }),
            Response.json({ message: 'Invalid email or password' }, { status: 401 }),
            { durationMs: 1 },
        )

        expect(logger.info.mock.calls[0][1]).toMatchObject({
            responseBody: { error: { message: 'graphId required' } },
        })
        expect(logger.info.mock.calls[1][1]).not.toHaveProperty('responseBody')
    })

    it('still logs a request whose client address the adapter cannot resolve', async () => {
        const logger = appLogger()
        await logRequest(
            { logger, hostname: 'pod-1' },
            requestEvent('https://sync.test/login', { address: new Error('Address header was requested to be x-real-ip but is absent from request') }),
            new Response('ok'),
            { durationMs: 1 },
        )

        expect(logger.info).toHaveBeenCalledWith('HTTP request', expect.objectContaining({ ip: undefined }))
    })
})

describe('createHandleError', () => {
    it('never logs a 404 at error: the request line already records it', () => {
        const logger = appLogger()
        const handleError = createHandleError({ logger, hostname: 'pod-1' })
        const result = handleError({
            error: new Error('Not found: /favicon.ico'),
            event: requestEvent('https://www.test/favicon.ico'),
            status: 404,
            message: 'Not Found',
        })

        expect(result).toEqual({ message: 'Page not found' })
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
    })

    it('logs an unexpected failure at error with its stack, and shows the visitor nothing of it', () => {
        const logger = appLogger()
        const handleError = createHandleError({ logger, hostname: 'pod-1' })
        const result = handleError({
            error: new Error('database is down'),
            event: requestEvent('https://www.test/g/abc/d/Private?email=a%40b.test'),
            status: 500,
            message: 'Internal Error',
        })

        expect(result).toEqual({ message: 'Something went wrong' })
        expect(logger.error).toHaveBeenCalledWith('Unexpected server error', expect.objectContaining({
            status: 500,
            path: '/g/abc/d/[redacted]',
            query: '?email=[redacted]',
            error: 'database is down',
            stack: expect.stringContaining('database is down'),
            hostname: 'pod-1',
        }))
    })
})
