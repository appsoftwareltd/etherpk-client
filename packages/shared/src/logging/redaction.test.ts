import { describe, expect, it } from 'vitest'
import {
    redactPath,
    redactQueryString,
    redactRequestQuery,
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
        expect(redactQueryString('?redirect=%2Fgraph%2Fsync%2Fabc%2Fd%2FPrivate%20Diary&prompt=none')).toBe(
            '?redirect=/graph/sync/abc/d/[redacted]&prompt=none',
        )
        expect(redactQueryString('?redirect=%2Fgraph%2Ffolder%2FPrivate%20Notes%2Fd%2FDiary')).toBe('?redirect=/graph/folder/[redacted]')
        expect(redactQueryString('?redirect=%2Fgraphs%3Fmanaged%3Dconnected')).toBe('?redirect=%2Fgraphs%3Fmanaged%3Dconnected')
    })

    it('redacts a shared note carried in a return path to the share page', () => {
        // A share opened before sign-in comes back through /auth/login?redirect=/share?...
        expect(redactQueryString('?redirect=%2Fshare%3Ftext%3Dwater%2520the%2520beans&prompt=none')).toBe(
            '?redirect=/share?[redacted]&prompt=none',
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

describe('redactRequestQuery', () => {
    it('redacts the whole query string of the share page, which is the shared note itself', () => {
        expect(redactRequestQuery('/share', '?title=Garden&text=water%20the%20beans&url=https%3A%2F%2Fexample.test%2Fbeans')).toBe(
            '?[redacted]',
        )
        expect(redactRequestQuery('/SHARE/', '?text=water%20the%20beans')).toBe('?[redacted]')
    })

    it('returns undefined for a share page with no query string', () => {
        expect(redactRequestQuery('/share', '')).toBeUndefined()
        expect(redactRequestQuery('/share', '?')).toBeUndefined()
    })

    it('judges every other path parameter by parameter', () => {
        expect(redactRequestQuery('/graphs', '?token=abc&page=2')).toBe('?token=[redacted]&page=2')
        expect(redactRequestQuery('/shared', '?text=Garden')).toBe('?text=Garden')
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
        expect(redactPath('/graph/sync/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/d/Journal/2026-09-24')).toBe(
            '/graph/sync/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/d/[redacted]',
        )
    })

    // Every address shape a workspace route accepts (ADR 0192). A rule missed here writes a
    // person's words into a log, and no screen or other test would show it.
    it.each([
        // A document, an asset and a theme, on a synced graph and one kept in the browser.
        ['/graph/sync/abc/d/Garden/Beds', '/graph/sync/abc/d/[redacted]'],
        ['/graph/browser/abc/d/Garden', '/graph/browser/abc/d/[redacted]'],
        ['/graph/sync/abc/a/asset-1', '/graph/sync/abc/a/[redacted]'],
        ['/graph/sync/abc/t/theme-1', '/graph/sync/abc/t/[redacted]'],
        // An extension's View about a concept, built in or from the Extension Directory.
        ['/graph/sync/abc/k/Garden%20Board', '/graph/sync/abc/k/[redacted]'],
        ['/graph/sync/abc/m/Allotment', '/graph/sync/abc/m/[redacted]'],
        ['/graph/sync/abc/x/some-extension/board/Garden', '/graph/sync/abc/x/[redacted]'],
        // A folder graph: the folder's name is the person's own word too.
        ['/graph/folder/Private%20Notes', '/graph/folder/[redacted]'],
        ['/graph/folder/Private%20Notes/d/Garden', '/graph/folder/[redacted]'],
        ['/graph/folder/Private%20Notes/kanban', '/graph/folder/[redacted]'],
        // The shape before ADR 0192, while its redirect exists.
        ['/g/abc/d/Garden', '/g/abc/d/[redacted]'],
        ['/g/abc/k/Garden%20Board', '/g/abc/k/[redacted]'],
    ])('keeps a person\'s words out of %s', (path, logged) => {
        expect(redactPath(path)).toBe(logged)
        expect(redactPath(path.toUpperCase())).not.toContain('GARDEN')
        expect(redactPath(path.toUpperCase())).not.toContain('PRIVATE')
    })

    it.each(['/graph/sync/abc', '/graph/browser/abc', '/graph/sync/abc/kanban', '/graph/sync/abc/graph-view', '/graphs', '/g/abc'])(
        'keeps %s, which names no document',
        (path) => {
            expect(redactPath(path)).toBe(path)
        },
    )

    it('leaves every other path byte-for-byte intact', () => {
        expect(redactPath('/api/auth/reset-password')).toBe('/api/auth/reset-password')
        expect(redactPath('/api/v1/sync/graphs/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(
            '/api/v1/sync/graphs/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        )
    })
})

describe('redactUrl', () => {
    it('redacts both the path and the query of a redirect target', () => {
        expect(redactUrl('https://app.test/graph/sync/abc/d/Private%20Diary?code=1&x=2')).toBe(
            'https://app.test/graph/sync/abc/d/[redacted]?code=[redacted]&x=2',
        )
        expect(redactUrl('/api/auth/reset-password/tok?callbackURL=/x')).toBe(
            '/api/auth/reset-password/[redacted]?callbackURL=/x',
        )
    })

    it('redacts the query string of a redirect to the share page, keeping its fragment', () => {
        expect(redactUrl('/share?text=water%20the%20beans#add')).toBe('/share?[redacted]#add')
        expect(redactUrl('https://app.test/share?title=Garden&url=https%3A%2F%2Fexample.test')).toBe(
            'https://app.test/share?[redacted]',
        )
        expect(redactUrl('https://app.test/share')).toBe('https://app.test/share')
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
