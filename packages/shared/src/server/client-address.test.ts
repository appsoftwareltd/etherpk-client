import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AUTH_CLIENT_ADDRESS_HEADER,
    AUTH_IP_ADDRESS_OPTIONS,
    UNRESOLVED_CLIENT_ADDRESS,
    createAuthClientAddressStamp,
} from './client-address'

function appLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function authRequest(headers: Record<string, string> = {}) {
    return new Request('https://sync.test/api/auth/sign-in/email', { method: 'POST', headers })
}

describe('stamping the client address Better Auth reads', () => {
    let logger: ReturnType<typeof appLogger>
    beforeEach(() => {
        logger = appLogger()
    })

    it('points Better Auth at one header, never at X-Forwarded-For', () => {
        expect(AUTH_IP_ADDRESS_OPTIONS).toEqual({ ipAddressHeaders: [AUTH_CLIENT_ADDRESS_HEADER] })
    })

    it('writes the adapter-resolved address and discards a copy the browser forged', () => {
        const stamp = createAuthClientAddressStamp(logger)
        const request = authRequest({
            [AUTH_CLIENT_ADDRESS_HEADER]: '198.51.100.1',
            'x-forwarded-for': '198.51.100.2',
        })

        stamp(request, '203.0.113.9', { addressHeader: 'x-real-ip', production: true })

        expect(request.headers.get(AUTH_CLIENT_ADDRESS_HEADER)).toBe('203.0.113.9')
    })

    it('fails closed when the address cannot be resolved: one shared bucket, and a warning', () => {
        // adapter-node throws when ADDRESS_HEADER names a header the request lacks, for instance
        // a request that reached the origin without passing through the proxy. Without a value
        // Better Auth skips rate limiting altogether, so such requests share one strict bucket.
        const stamp = createAuthClientAddressStamp(logger)
        const request = authRequest({ [AUTH_CLIENT_ADDRESS_HEADER]: '198.51.100.1' })

        stamp(request, undefined, { addressHeader: 'x-real-ip', production: true })
        stamp(authRequest(), undefined, { addressHeader: 'x-real-ip', production: true })

        expect(request.headers.get(AUTH_CLIENT_ADDRESS_HEADER)).toBe(UNRESOLVED_CLIENT_ADDRESS)
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(
            'auth client address unresolved; sharing one rate-limit bucket',
            expect.objectContaining({ addressHeader: 'x-real-ip' }),
        )
    })

    it('warns once when a proxy is in front but ADDRESS_HEADER is unset', () => {
        // Every visitor then arrives from the proxy's address and shares its rate-limit bucket.
        const stamp = createAuthClientAddressStamp(logger)

        stamp(authRequest({ 'x-forwarded-for': '203.0.113.9' }), '10.0.0.2', { addressHeader: undefined, production: true })
        stamp(authRequest({ 'x-real-ip': '203.0.113.9' }), '10.0.0.2', { addressHeader: undefined, production: true })

        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(
            'requests arrive through a proxy but ADDRESS_HEADER is unset; every client shares the proxy address',
            expect.objectContaining({ proxyHeaders: ['x-forwarded-for'], resolvedAddress: '10.0.0.2' }),
        )
    })

    it('stays quiet for a directly exposed server, a configured proxy and a development server', () => {
        const stamp = createAuthClientAddressStamp(logger)

        stamp(authRequest(), '203.0.113.9', { addressHeader: undefined, production: true })
        stamp(authRequest({ 'x-real-ip': '203.0.113.9' }), '203.0.113.9', { addressHeader: 'x-real-ip', production: true })
        stamp(authRequest({ 'x-forwarded-for': '203.0.113.9' }), '127.0.0.1', { addressHeader: undefined, production: false })

        expect(logger.warn).not.toHaveBeenCalled()
    })
})
