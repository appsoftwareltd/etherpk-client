import type { Cookies } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import {
    clearClientSsoSuppression,
    CLIENT_SSO_ATTEMPT_COOKIE,
    CLIENT_SSO_SUPPRESSION_COOKIE,
    isClientSsoSuppressed,
    setClientSsoAttempted,
    suppressClientSso,
    takeClientSsoAttempted,
} from './cookies'

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
