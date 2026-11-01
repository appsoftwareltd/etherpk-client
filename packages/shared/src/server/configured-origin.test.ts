import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { ORIGIN_HOST_HEADER, ORIGIN_PROTOCOL_HEADER, configureOrigin, parseConfiguredOrigin } from './configured-origin'

function request(headers: Record<string, string> = {}): IncomingMessage {
    return { headers: { ...headers } } as unknown as IncomingMessage
}

describe('parseConfiguredOrigin', () => {
    it('reads an HTTP or HTTPS origin, and nothing when the setting is unset or blank', () => {
        expect(parseConfiguredOrigin('https://sync.example.com')).toEqual({ protocol: 'https', host: 'sync.example.com' })
        expect(parseConfiguredOrigin('http://nas.local:3000/')).toEqual({ protocol: 'http', host: 'nas.local:3000' })
        expect(parseConfiguredOrigin(undefined)).toBeNull()
        expect(parseConfiguredOrigin('  ')).toBeNull()
    })

    it('refuses a value that is not an HTTP or HTTPS origin, so the server does not start on it', () => {
        expect(() => parseConfiguredOrigin('sync.example.com')).toThrow(/ORIGIN/)
        expect(() => parseConfiguredOrigin('ftp://sync.example.com')).toThrow(/ORIGIN/)
        expect(() => parseConfiguredOrigin('https://sync.example.com/app')).toThrow(/ORIGIN/)
    })
})

describe('configureOrigin', () => {
    it('leaves the environment alone and stamps nothing when ORIGIN is unset', () => {
        const environment: Record<string, string | undefined> = { PROTOCOL_HEADER: 'x-forwarded-proto' }

        expect(configureOrigin(environment)).toBeNull()
        expect(environment).toEqual({ PROTOCOL_HEADER: 'x-forwarded-proto' })
    })

    it("points the Node adapter's header settings at headers stamped from ORIGIN on every request", () => {
        // adapter-node 6 no longer reads ORIGIN. It takes the origin from PROTOCOL_HEADER and
        // HOST_HEADER, which win over the request's own Host, even one a proxy rewrote.
        const environment: Record<string, string | undefined> = {
            ORIGIN: 'http://nas.local:3000',
            PROTOCOL_HEADER: 'x-forwarded-proto',
            HOST_HEADER: 'x-forwarded-host',
            PORT_HEADER: 'x-forwarded-port',
        }
        const stamp = configureOrigin(environment)
        const req = request({ host: 'internal:8080', [ORIGIN_HOST_HEADER]: 'evil.example', 'x-forwarded-port': '443' })
        stamp?.(req)

        expect(environment.PROTOCOL_HEADER).toBe(ORIGIN_PROTOCOL_HEADER)
        expect(environment.HOST_HEADER).toBe(ORIGIN_HOST_HEADER)
        expect(environment.PORT_HEADER).toBeUndefined()
        expect(req.headers[ORIGIN_PROTOCOL_HEADER]).toBe('http')
        expect(req.headers[ORIGIN_HOST_HEADER]).toBe('nas.local:3000')
        expect(req.headers.host).toBe('internal:8080')
    })
})
