import { describe, expect, it } from 'vitest'
import {
    buildManagedClientSsoCheckUrl,
    managedClientSsoCheckResponse,
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
        checked: false,
        arrivedFromAnotherOrigin: false,
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

    // Without the marker every signed-out page load would run the check, four redirects through
    // Corporate each, until Corporate's per-address authorize limit answers raw JSON.
    it('does not check again for a while after a silent miss', () => {
        expect(shouldAttemptManagedClientSso({ ...documentRequest, checked: true })).toBe(false)
    })

    it('checks again on arrival from another origin, as from Corporate just after signing in there', () => {
        expect(shouldAttemptManagedClientSso({ ...documentRequest, checked: true, arrivedFromAnotherOrigin: true }))
            .toBe(true)
    })

    it("never repeats on the check's own return, which also arrives from Corporate", () => {
        expect(shouldAttemptManagedClientSso({
            ...documentRequest,
            attempted: true,
            checked: true,
            arrivedFromAnotherOrigin: true,
        })).toBe(false)
    })

    // A cacheable 303 would be replayed from the HTTP cache on Back and Forward, without its
    // cookies, until the browser gives up with ERR_TOO_MANY_REDIRECTS.
    it('answers the silent check with a redirect no cache may keep', () => {
        const response = managedClientSsoCheckResponse(new URL('https://app.example.com/g/demo-graph'))

        expect(response.status).toBe(303)
        expect(response.headers.get('location')).toBe('/auth/login?redirect=%2Fg%2Fdemo-graph&prompt=none')
        expect(response.headers.get('cache-control')).toBe('no-store')
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
