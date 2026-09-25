import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { fetchPublicText, isPublicAddress, type PublicFetchDeps } from './public-fetch'

describe('isPublicAddress', () => {
    it('accepts ordinary public addresses', () => {
        for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
            expect(isPublicAddress(address)).toBe(true)
        }
    })

    it('refuses loopback, private, link-local, reserved and mapped forms of them', () => {
        for (const address of [
            '127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
            '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
            '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not an address',
        ]) {
            expect(isPublicAddress(address)).toBe(false)
        }
    })
})

/** An https transport that answers from a table, resolving each host through the guarded lookup as a real socket would. */
function transport(routes: Record<string, { status: number; headers?: Record<string, string>; body?: string }>, dns: Record<string, string>) {
    const requested: string[] = []
    const deps: PublicFetchDeps = {
        lookup: ((hostname: string, _options: unknown, callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void) => {
            const address = dns[hostname]
            if (!address) return callback(Object.assign(new Error(`no such host ${hostname}`), { code: 'ENOTFOUND' }))
            callback(null, [{ address, family: address.includes(':') ? 6 : 4 }])
        }) as PublicFetchDeps['lookup'],
        request: ((url: URL, options: { lookup: (host: string, opts: object, cb: (error: Error | null) => void) => void }, respond: (res: unknown) => void) => {
            const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void }
            req.destroy = (error?: Error) => {
                if (error) req.emit('error', error)
            }
            req.end = () => {
                options.lookup(url.hostname, { all: true }, (error) => {
                    if (error) return req.emit('error', error)
                    requested.push(url.href)
                    const route = routes[url.href]
                    const res = Object.assign(new PassThrough(), { statusCode: route?.status ?? 404, statusMessage: 'x', headers: route?.headers ?? {} })
                    respond(res)
                    res.end(route?.body ?? '')
                })
            }
            return req
        }) as unknown as PublicFetchDeps['request'],
    }
    return { deps, requested }
}

describe('fetchPublicText', () => {
    it('fetches an https URL on a public host', async () => {
        const { deps } = transport({ 'https://themes.example.com/t/theme.json': { status: 200, body: '{"title":"T"}' } }, { 'themes.example.com': '93.184.216.34' })
        expect(await fetchPublicText('https://themes.example.com/t/theme.json', deps)).toBe('{"title":"T"}')
    })

    it('refuses anything but https, and URLs carrying credentials', async () => {
        const { deps, requested } = transport({}, { 'themes.example.com': '93.184.216.34' })
        await expect(fetchPublicText('http://themes.example.com/theme.json', deps)).rejects.toThrow(/https/)
        await expect(fetchPublicText('file:///etc/passwd', deps)).rejects.toThrow(/https/)
        await expect(fetchPublicText('https://user:pass@themes.example.com/theme.json', deps)).rejects.toThrow(/credentials/)
        expect(requested).toEqual([])
    })

    it('refuses a host that resolves to a private or loopback address, before any request is made', async () => {
        const { deps, requested } = transport({}, { 'intranet.example.com': '10.1.2.3', 'metadata.example.com': '169.254.169.254', localhost: '127.0.0.1', '127.0.0.1': '127.0.0.1' })
        for (const url of ['https://intranet.example.com/x', 'https://metadata.example.com/latest', 'https://localhost/x', 'https://127.0.0.1/x']) {
            await expect(fetchPublicText(url, deps)).rejects.toThrow(/not a public address/)
        }
        expect(requested).toEqual([])
    })

    it('follows a redirect only to another public https URL', async () => {
        const dns = { 'a.example.com': '93.184.216.34', 'b.example.com': '93.184.216.35', 'inside.example.com': '192.168.0.10' }
        const good = transport({
            'https://a.example.com/theme.json': { status: 302, headers: { location: 'https://b.example.com/theme.json' } },
            'https://b.example.com/theme.json': { status: 200, body: 'moved' },
        }, dns)
        expect(await fetchPublicText('https://a.example.com/theme.json', good.deps)).toBe('moved')

        const toPrivate = transport({ 'https://a.example.com/theme.json': { status: 301, headers: { location: 'https://inside.example.com/theme.json' } } }, dns)
        await expect(fetchPublicText('https://a.example.com/theme.json', toPrivate.deps)).rejects.toThrow(/not a public address/)

        const toHttp = transport({ 'https://a.example.com/theme.json': { status: 307, headers: { location: 'http://b.example.com/theme.json' } } }, dns)
        await expect(fetchPublicText('https://a.example.com/theme.json', toHttp.deps)).rejects.toThrow(/https/)

        const loop = transport({ 'https://a.example.com/theme.json': { status: 302, headers: { location: 'https://a.example.com/theme.json' } } }, dns)
        await expect(fetchPublicText('https://a.example.com/theme.json', loop.deps)).rejects.toThrow(/redirect/)
    })

    it('refuses a response larger than the cap, and a non-2xx answer', async () => {
        const dns = { 'a.example.com': '93.184.216.34' }
        const big = transport({ 'https://a.example.com/big.css': { status: 200, body: 'x'.repeat(2048) } }, dns)
        await expect(fetchPublicText('https://a.example.com/big.css', { ...big.deps, maxBytes: 1024 })).rejects.toThrow(/larger than/)
        const missing = transport({}, dns)
        await expect(fetchPublicText('https://a.example.com/none.css', missing.deps)).rejects.toThrow(/404/)
    })
})
