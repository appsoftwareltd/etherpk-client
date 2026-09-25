import { describe, expect, it } from 'vitest'
import { decryptSessionCookie, encryptSessionCookie, isManagedSession } from './session-cookie'

const secret = 'a-client-session-secret-with-32-bytes'

describe('encrypted managed session cookie', () => {
    it('round-trips a rotating refresh token without exposing it in the cookie', async () => {
        const session = {
            refreshToken: `refresh.${'x'.repeat(1400)}`,
            idToken: `id.${'y'.repeat(1200)}`,
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        }

        const encrypted = await encryptSessionCookie(session, secret, 'managed-session')

        expect(encrypted).not.toContain(session.refreshToken)
        expect(encrypted).not.toContain(session.idToken)
        expect(encrypted.length).toBeLessThan(3800)
        await expect(decryptSessionCookie(encrypted, secret, 'managed-session')).resolves.toEqual(session)
    })

    it('rejects legacy or malformed values which cannot complete managed logout', () => {
        expect(isManagedSession({ refreshToken: 'refresh', expiresAt: Date.now() + 60_000 })).toBe(false)
        expect(isManagedSession({ refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 60_000 })).toBe(true)
        expect(isManagedSession({ refreshToken: 'refresh', idToken: 'id', expiresAt: 'later' })).toBe(false)
    })

    it('fails closed when ciphertext is modified or the key changes', async () => {
        const encrypted = await encryptSessionCookie({ refreshToken: 'refresh-token', expiresAt: Date.now() + 60_000 }, secret, 'managed-session')
        const parts = encrypted.split('.')
        parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`

        await expect(decryptSessionCookie(parts.join('.'), secret, 'managed-session')).rejects.toThrow()
        await expect(decryptSessionCookie(encrypted, `${secret}-different`, 'managed-session')).rejects.toThrow()
    })

    /**
     * Both cookies are encrypted under the same configured secret. Each purpose derives its own
     * key and is bound in as AAD, so an OAuth transaction cookie replayed into the
     * managed-session slot fails to decrypt instead of resting on a shape check.
     */
    it('cannot be replayed into the other cookie slot', async () => {
        const transaction = { state: 's', nonce: 'n', codeVerifier: 'v', returnPath: '/', createdAt: Date.now() }

        const encrypted = await encryptSessionCookie(transaction, secret, 'oauth-transaction')

        await expect(decryptSessionCookie(encrypted, secret, 'oauth-transaction')).resolves.toEqual(transaction)
        // Different key AND unbound AAD: it fails authentication rather than being parsed.
        await expect(decryptSessionCookie(encrypted, secret, 'managed-session')).rejects.toThrow()
    })

    it('derives a different key per purpose from the one secret', async () => {
        const value = { a: 1 }
        const asSession = await encryptSessionCookie(value, secret, 'managed-session')
        const asTransaction = await encryptSessionCookie(value, secret, 'oauth-transaction')
        // Both are v2 envelopes; the point is that neither opens under the other's purpose.
        expect(asSession.split('.')[0]).toBe('v2')
        expect(asTransaction.split('.')[0]).toBe('v2')
        await expect(decryptSessionCookie(asSession, secret, 'oauth-transaction')).rejects.toThrow()
    })

    it('refuses a v1 envelope, so the weaker construction cannot be presented', async () => {
        const encrypted = await encryptSessionCookie({ a: 1 }, secret, 'managed-session')
        const downgraded = ['v1', ...encrypted.split('.').slice(1)].join('.')
        await expect(decryptSessionCookie(downgraded, secret, 'managed-session')).rejects.toThrow()
    })
})
