import type { Cookies } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import {
    clearClientSsoChecked,
    clearClientSsoSuppression,
    CLIENT_SSO_ATTEMPT_COOKIE,
    CLIENT_SSO_CHECKED_COOKIE,
    isClientSsoChecked,
    markClientSsoChecked,
    CLIENT_SSO_SUPPRESSION_COOKIE,
    isClientSsoSuppressed,
    setClientSsoAttempted,
    setManagedSession,
    suppressClientSso,
    takeClientSsoAttempted,
} from './cookies'
import { MANAGED_SESSION_COOKIE, decryptSessionCookie, type ManagedSession } from './session-cookie'
import type { ManagedClientAuthConfig } from './config'

const config = { sessionSecret: 'a-client-session-secret-with-32-bytes' } as ManagedClientAuthConfig

interface RecordedCookie {
    value: string
    options: Record<string, unknown>
}

function cookieJar() {
    const values = new Map<string, RecordedCookie>()
    const cookies = {
        get(name: string) {
            return values.get(name)?.value
        },
        set(name: string, value: string, options: Record<string, unknown>) {
            values.set(name, { value, options })
        },
        delete(name: string) {
            values.delete(name)
        },
    } as unknown as Cookies
    return { cookies, values }
}

describe('managed Client SSO control cookies', () => {
    it('consumes the short-lived silent-attempt loop guard once', () => {
        const { cookies, values } = cookieJar()

        setClientSsoAttempted(cookies)
        expect(values.get(CLIENT_SSO_ATTEMPT_COOKIE)).toEqual({
            value: '1',
            options: {
                path: '/',
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                maxAge: 60,
            },
        })
        expect(takeClientSsoAttempted(cookies)).toBe(true)
        expect(takeClientSsoAttempted(cookies)).toBe(false)
    })

    // The one-request guard alone would let every signed-out page load run the silent check
    // again, four redirects through Corporate each, until Corporate's per-address authorize limit
    // answers raw JSON.
    it('remembers a silent miss for thirty minutes, until an explicit sign-in clears it', () => {
        const { cookies, values } = cookieJar()

        markClientSsoChecked(cookies)
        expect(isClientSsoChecked(cookies)).toBe(true)
        expect(values.get(CLIENT_SSO_CHECKED_COOKIE)?.options).toEqual({
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 30 * 60,
        })

        clearClientSsoChecked(cookies)
        expect(isClientSsoChecked(cookies)).toBe(false)
    })

    it('retains Client-only disconnect suppression until explicit sign-in clears it', () => {
        const { cookies, values } = cookieJar()

        suppressClientSso(cookies)
        expect(isClientSsoSuppressed(cookies)).toBe(true)
        expect(values.get(CLIENT_SSO_SUPPRESSION_COOKIE)?.options).toEqual({
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
        })

        clearClientSsoSuppression(cookies)
        expect(isClientSsoSuppressed(cookies)).toBe(false)
    })
})

describe('the managed session cookie', () => {
    const base: ManagedSession = {
        refreshToken: `refresh.${'r'.repeat(40)}`,
        idToken: `id.${'i'.repeat(900)}`,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }

    it('keeps the access token beside the refresh grant, so a page load need not refresh', async () => {
        const { cookies, values } = cookieJar()
        const accessExpiresAt = Date.now() + 15 * 60 * 1000

        await setManagedSession(cookies, { ...base, accessToken: `access.${'a'.repeat(900)}`, accessExpiresAt }, config)

        const stored = await decryptSessionCookie(values.get(MANAGED_SESSION_COOKIE)?.value ?? '', config.sessionSecret, 'managed-session')
        expect(stored).toMatchObject({ accessToken: `access.${'a'.repeat(900)}`, accessExpiresAt })
    })

    it('drops only the held access token when the cookie would outgrow the safe size', async () => {
        // The held token is a cache: without it the next page load refreshes.
        const { cookies, values } = cookieJar()

        await setManagedSession(cookies, { ...base, accessToken: 'a'.repeat(2400), accessExpiresAt: Date.now() + 60_000 }, config)

        const cookie = values.get(MANAGED_SESSION_COOKIE)?.value ?? ''
        expect(cookie.length).toBeLessThanOrEqual(3800)
        const stored = await decryptSessionCookie(cookie, config.sessionSecret, 'managed-session')
        expect(stored).toEqual(base)
    })
})
