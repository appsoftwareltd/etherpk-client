import { describe, expect, it } from 'vitest'
import {
    redactPath,
    redactQueryString,
    redactUrl,
    redactUrlQuery,
    shouldCaptureErrorResponseBody,
} from './redaction'

describe('redactQueryString', () => {
    it('returns undefined for an absent or empty query string', () => {
        expect(redactQueryString(undefined)).toBeUndefined()
        expect(redactQueryString(null)).toBeUndefined()
        expect(redactQueryString('')).toBeUndefined()
        expect(redactQueryString('?')).toBeUndefined()
    })

    it('redacts an email verification token', () => {
        expect(redactQueryString('?token=abc123&callbackURL=/account')).toBe(
            '?token=[redacted]&callbackURL=/account',
        )
    })

    it('redacts the OAuth callback code and state', () => {
        expect(redactQueryString('?code=4/0Ab&state=xyz&scope=email')).toBe(
            '?code=[redacted]&state=[redacted]&scope=email',
        )
    })

    it('redacts every parameter whose name carries a secret', () => {
        const search =
            '?id_token=a&access_token=b&refresh_token=c&client_secret=d&nonce=e&code_verifier=f&password=g'
        expect(redactQueryString(search)).toBe(
            '?id_token=[redacted]&access_token=[redacted]&refresh_token=[redacted]'
            + '&client_secret=[redacted]&nonce=[redacted]&code_verifier=[redacted]&password=[redacted]',
        )
    })

    it('matches parameter names case-insensitively and when percent-encoded', () => {
        expect(redactQueryString('?ToKeN=abc')).toBe('?ToKeN=[redacted]')
        expect(redactQueryString('?%74oken=abc')).toBe('?%74oken=[redacted]')
    })

    it('redacts any parameter whose name contains token, secret or password', () => {
        expect(redactQueryString('?csrf_token=a&app_secret=b&new_password=c')).toBe(
            '?csrf_token=[redacted]&app_secret=[redacted]&new_password=[redacted]',
        )
    })

    it('redacts an email address, which is personal data rather than a diagnostic', () => {
        // The invite lookup and the verification landing page (/login?email=) both carried one.
        expect(redactQueryString('?email=person%40example.com&callbackURL=/account')).toBe(
            '?email=[redacted]&callbackURL=/account',
        )
        expect(redactQueryString('?inviteeEmail=a%40b.test')).toBe('?inviteeEmail=[redacted]')
    })

    it('redacts a document name carried in a return path', () => {
        // The Client's silent sign-in sends /auth/login?redirect=<the page being opened>.
        expect(redactQueryString('?redirect=%2Fg%2Fabc%2Fd%2FPrivate%20Diary&prompt=none')).toBe(
            '?redirect=/g/abc/d/[redacted]&prompt=none',
        )
        expect(redactQueryString('?redirect=%2Fgraphs%3Fmanaged%3Dconnected')).toBe('?redirect=%2Fgraphs%3Fmanaged%3Dconnected')
    })

    it('leaves diagnostic parameters intact', () => {
        expect(redactQueryString('?page=2&sort=name&graphId=abc-123')).toBe(
            '?page=2&sort=name&graphId=abc-123',
        )
    })

    it('leaves a valueless parameter alone, since it carries no secret', () => {
        expect(redactQueryString('?token&page=2')).toBe('?token&page=2')
    })

    it('does not treat a secret appearing in a value as a parameter name', () => {
        expect(redactQueryString('?next=/login?token%3Dabc')).toBe('?next=/login?token%3Dabc')
    })
})

describe('redactUrlQuery', () => {
    it('returns the value unchanged when it carries no query string', () => {
        expect(redactUrlQuery('/account')).toBe('/account')
        expect(redactUrlQuery('https://example.test/account')).toBe('https://example.test/account')
    })

    it('redacts an OAuth redirect Location header', () => {
        expect(redactUrlQuery('https://app.test/callback?code=4/0Ab&state=xyz')).toBe(
            'https://app.test/callback?code=[redacted]&state=[redacted]',
        )
    })

    it('preserves a fragment while redacting the query', () => {
        expect(redactUrlQuery('/verify?token=abc#done')).toBe('/verify?token=[redacted]#done')
    })

    it('passes through null and undefined', () => {
        expect(redactUrlQuery(null)).toBeNull()
        expect(redactUrlQuery(undefined)).toBeUndefined()
    })
})

describe('redactPath', () => {
    it('redacts the password-reset token Better Auth carries in the path', () => {
        // better-auth 1.6.15 mails `${baseURL}/reset-password/${token}?callbackURL=...`; the GET
        // does not consume the token, so a logged path is a password reset for anyone who reads it.
        expect(redactPath('/api/auth/reset-password/Xk2pQ9vLmN4rT7wYz8aB')).toBe(
            '/api/auth/reset-password/[redacted]',
        )
    })

    it('matches the route whatever its case and keeps a trailing segment out of the log too', () => {
        expect(redactPath('/API/Auth/Reset-Password/abc/extra')).toBe('/API/Auth/Reset-Password/[redacted]')
    })

    it('redacts the document name in a Client document address', () => {
        // Document names are the user's content; the Client server never needs them in a log.
        expect(redactPath('/g/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/d/Journal/2026-09-24')).toBe(
            '/g/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/d/[redacted]',
        )
    })

    it('leaves every other path byte-for-byte intact', () => {
        expect(redactPath('/api/auth/reset-password')).toBe('/api/auth/reset-password')
        expect(redactPath('/api/v1/sync/graphs/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(
            '/api/v1/sync/graphs/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        )
        expect(redactPath('/g/abc/t/theme-1')).toBe('/g/abc/t/theme-1')
    })
})

describe('redactUrl', () => {
    it('redacts both the path and the query of a redirect target', () => {
        expect(redactUrl('https://app.test/g/abc/d/Private%20Diary?code=1&x=2')).toBe(
            'https://app.test/g/abc/d/[redacted]?code=[redacted]&x=2',
        )
        expect(redactUrl('/api/auth/reset-password/tok?callbackURL=/x')).toBe(
            '/api/auth/reset-password/[redacted]?callbackURL=/x',
        )
    })

    it('leaves an ordinary target alone and passes through null', () => {
        expect(redactUrl('https://www.example.test/account#top')).toBe('https://www.example.test/account#top')
        expect(redactUrl(null)).toBeNull()
    })
})

describe('shouldCaptureErrorResponseBody', () => {
    it('captures API error bodies for diagnostics', () => {
        expect(shouldCaptureErrorResponseBody('/api/v1/sync/graphs')).toBe(true)
    })

    it('never captures better-auth error bodies, which carry credential detail', () => {
        expect(shouldCaptureErrorResponseBody('/api/auth/sign-in/email')).toBe(false)
        expect(shouldCaptureErrorResponseBody('/api/auth/verify-email')).toBe(false)
    })

    it('ignores non-API paths', () => {
        expect(shouldCaptureErrorResponseBody('/login')).toBe(false)
    })
})
