import { describe, expect, it } from 'vitest'
import {
    redactQueryString,
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
