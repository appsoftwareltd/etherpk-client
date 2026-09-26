import { describe, expect, it } from 'vitest'
import { applyPrivateCacheControl, applySecurityHeaders, isPrivateResponse, securityHeaders } from './headers'

describe('securityHeaders', () => {
    it('declines MIME sniffing', () => {
        expect(securityHeaders({ https: true })['X-Content-Type-Options']).toBe('nosniff')
    })

    it('refuses framing for browsers that predate frame-ancestors', () => {
        expect(securityHeaders({ https: true })['X-Frame-Options']).toBe('DENY')
    })

    it('keeps URLs out of cross-origin Referer headers', () => {
        expect(securityHeaders({ https: true })['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    })

    it('declines the powerful features the product does not use', () => {
        expect(securityHeaders({ https: true })['Permissions-Policy']).toContain('camera=()')
    })

    it('sends HSTS over HTTPS', () => {
        expect(securityHeaders({ https: true })['Strict-Transport-Security'])
            .toBe('max-age=31536000; includeSubDomains')
    })

    it('never sends HSTS over plain HTTP, so local development is not pinned', () => {
        expect(securityHeaders({ https: false })['Strict-Transport-Security']).toBeUndefined()
    })
})

describe('applySecurityHeaders', () => {
    it('sets every header on the response', () => {
        const response = new Response(null)
        applySecurityHeaders(response, { https: true })
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=')
    })

    it('leaves headers the app already set alone', () => {
        const response = new Response(null, { headers: { 'Accept-CH': 'Sec-CH-Prefers-Color-Scheme' } })
        applySecurityHeaders(response, { https: false })
        expect(response.headers.get('Accept-CH')).toBe('Sec-CH-Prefers-Color-Scheme')
    })
})

describe('isPrivateResponse', () => {
    it('keeps anything answered to a signed-in or token-bearing request out of every cache', () => {
        expect(isPrivateResponse({ credentialed: true, routeId: '/(marketing)/home', pathname: '/home' })).toBe(true)
        expect(isPrivateResponse({ credentialed: true, routeId: null, pathname: '/api/auth/get-session' })).toBe(true)
    })

    it('keeps the signed-in pages private even when the session has gone', () => {
        expect(isPrivateResponse({ credentialed: false, routeId: '/(app)/account/tokens', pathname: '/account/tokens' })).toBe(true)
        expect(isPrivateResponse({ credentialed: false, routeId: '/(app)', pathname: '/' })).toBe(true)
    })

    it('keeps the sign-in pages private, since they hold what was typed into them', () => {
        expect(isPrivateResponse({ credentialed: false, routeId: '/(auth)/login', pathname: '/login' })).toBe(true)
        expect(isPrivateResponse({ credentialed: false, routeId: '/(auth)/register', pathname: '/register' })).toBe(true)
    })

    it('treats a path prefix the app names as private', () => {
        const input = { credentialed: false, routeId: null, pathname: '/api/v1/sync/tokens' }
        expect(isPrivateResponse(input)).toBe(false)
        expect(isPrivateResponse(input, ['/api/v1/sync/'])).toBe(true)
    })

    it('leaves public pages cacheable for signed-out visitors', () => {
        expect(isPrivateResponse({ credentialed: false, routeId: '/(marketing)/home', pathname: '/home' })).toBe(false)
        expect(isPrivateResponse({ credentialed: false, routeId: '/(apps)/x', pathname: '/x' })).toBe(false)
        expect(isPrivateResponse({ credentialed: false, routeId: null, pathname: '/missing' })).toBe(false)
    })
})

describe('applyPrivateCacheControl', () => {
    it('replaces any caching the route chose with no-store, private', () => {
        const response = new Response(null, { headers: { 'Cache-Control': 'public, max-age=600' } })
        applyPrivateCacheControl(response)
        expect(response.headers.get('Cache-Control')).toBe('no-store, private')
    })
})
