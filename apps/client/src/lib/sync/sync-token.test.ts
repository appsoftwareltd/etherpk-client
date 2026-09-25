import { describe, expect, it, vi } from 'vitest'
import { createSyncTokenSource, fixedSyncToken, syncTokenExpiry } from './sync-token'

/** The server's token shape: base64url(JSON claims) + '.' + HMAC (opaque to the client). */
function token(exp: number, mac = 'sig'): string {
    const payload = btoa(JSON.stringify({ userId: 'u1', graphId: 'g1', exp }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    return `${payload}.${mac}`
}

const FIFTEEN_MINUTES = 15 * 60_000

describe('syncTokenExpiry', () => {
    it('reads exp out of a token without verifying it', () => {
        expect(syncTokenExpiry(token(1_700_000_000_000))).toBe(1_700_000_000_000)
    })

    it('returns null for anything it cannot read', () => {
        expect(syncTokenExpiry('not-a-token')).toBeNull()
        expect(syncTokenExpiry('bm90LWpzb24.sig')).toBeNull()
        expect(syncTokenExpiry(btoa(JSON.stringify({ userId: 'u' })) + '.sig')).toBeNull()
    })
})

describe('createSyncTokenSource', () => {
    it('mints once and reuses the token while it is comfortably valid', async () => {
        let now = 1_000_000
        const mint = vi.fn(async () => token(now + FIFTEEN_MINUTES))
        const source = createSyncTokenSource(mint, { now: () => now })

        const first = await source()
        now += 5 * 60_000
        expect(await source()).toBe(first)
        expect(mint).toHaveBeenCalledTimes(1)
    })

    it('re-mints before expiry, not after it - the live failure was a 401 at 15:00', async () => {
        let now = 1_000_000
        const mint = vi.fn(async () => token(now + FIFTEEN_MINUTES))
        const source = createSyncTokenSource(mint, { now: () => now })

        const first = await source()
        now += 12 * 60_000 // 3 minutes of life left: inside the quarter-life margin
        const second = await source()
        expect(second).not.toBe(first)
        expect(mint).toHaveBeenCalledTimes(2)
    })

    it('shares one in-flight mint between concurrent callers', async () => {
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const mint = vi.fn(async () => {
            await gate
            return token(Date.now() + FIFTEEN_MINUTES)
        })
        const source = createSyncTokenSource(mint)

        const all = Promise.all([source(), source(), source(), source(), source(), source()])
        release!()
        const tokens = await all
        expect(mint).toHaveBeenCalledTimes(1)
        expect(new Set(tokens).size).toBe(1)
    })

    it('propagates a mint failure and retries on the next call', async () => {
        const mint = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(token(Date.now() + FIFTEEN_MINUTES))
        const source = createSyncTokenSource(mint)

        await expect(source()).rejects.toThrow('offline')
        await expect(source()).resolves.toContain('.')
        expect(mint).toHaveBeenCalledTimes(2)
    })

    it('refreshes a token whose expiry it cannot read, rather than holding it forever', async () => {
        let now = 1_000_000
        const mint = vi.fn(async () => `opaque-${now}`)
        const source = createSyncTokenSource(mint, { now: () => now })

        const first = await source()
        now += 60_000
        expect(await source()).toBe(first) // still inside the assumed lifetime
        now += 5 * 60_000
        expect(await source()).not.toBe(first)
    })
})

describe('fixedSyncToken', () => {
    it('hands back the same token forever', async () => {
        const source = fixedSyncToken('gate-token')
        expect(await source()).toBe('gate-token')
        expect(await source()).toBe('gate-token')
    })
})
