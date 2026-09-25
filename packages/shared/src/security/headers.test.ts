import { describe, expect, it } from 'vitest'
import { applySecurityHeaders, securityHeaders } from './headers'

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
