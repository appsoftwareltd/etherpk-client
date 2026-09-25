import { describe, expect, it } from 'vitest'
import {
    buildManagedClientSsoCheckUrl,
    shouldAttemptManagedClientSso,
} from './managed-routing'

describe('managed Client automatic SSO', () => {
    const documentRequest = {
        configured: true,
        method: 'GET',
        pathname: '/',
        acceptsHtml: true,
        sessionAvailable: false,
        suppressed: false,
        attempted: false,
    }

    it.each(['/', '/home', '/graphs'])(
        'checks Corporate SSO for an anonymous document request to %s',
        (pathname) => {
            expect(shouldAttemptManagedClientSso({ ...documentRequest, pathname })).toBe(true)
        },
    )

    it('does not repeat a silent check on its immediate return request', () => {
        expect(shouldAttemptManagedClientSso({ ...documentRequest, attempted: true })).toBe(false)
    })

    it('keeps an explicit Client-only disconnect stable', () => {
        expect(shouldAttemptManagedClientSso({ ...documentRequest, suppressed: true })).toBe(false)
    })

    it('preserves the requested Client page in a silent login hand-off', () => {
        expect(buildManagedClientSsoCheckUrl(new URL('https://app.example.com/graphs?view=shared')))
            .toBe('/auth/login?redirect=%2Fgraphs%3Fview%3Dshared&prompt=none')
    })

    it.each([
        { name: 'standalone mode', change: { configured: false } },
        { name: 'an existing Client session', change: { sessionAvailable: true } },
        { name: 'a non-document request', change: { acceptsHtml: false } },
        { name: 'a POST request', change: { method: 'POST' } },
        { name: 'an OAuth route', change: { pathname: '/auth/callback' } },
        { name: 'a SvelteKit asset', change: { pathname: '/_app/immutable/entry/start.js' } },
    ])('does not check SSO for $name', ({ change }) => {
        expect(shouldAttemptManagedClientSso({ ...documentRequest, ...change })).toBe(false)
    })
})
