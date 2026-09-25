import { describe, expect, it } from 'vitest'
import { isSameOriginPost } from './same-origin'

const url = new URL('https://app.example.com/auth/token')
const post = (headers: Record<string, string>) => new Request(url, { method: 'POST', headers })

describe('isSameOriginPost', () => {
    it('accepts a POST the browser marks as same-origin', () => {
        expect(isSameOriginPost(post({ 'sec-fetch-site': 'same-origin' }), url)).toBe(true)
    })

    it('accepts a POST whose Origin is this app, when Sec-Fetch-Site is absent', () => {
        expect(isSameOriginPost(post({ origin: 'https://app.example.com' }), url)).toBe(true)
    })

    it('refuses a cross-site or same-site POST, whatever Origin claims', () => {
        // A sibling host on the same site is "same-site", not "same-origin": it must not sign the
        // user out or rotate their tokens either.
        expect(isSameOriginPost(post({ 'sec-fetch-site': 'cross-site' }), url)).toBe(false)
        expect(isSameOriginPost(post({ 'sec-fetch-site': 'same-site', origin: 'https://app.example.com' }), url)).toBe(false)
        expect(isSameOriginPost(post({ origin: 'https://attacker.example' }), url)).toBe(false)
        expect(isSameOriginPost(post({ origin: 'null' }), url)).toBe(false)
    })

    it('refuses a POST that carries neither header, which no current browser sends', () => {
        expect(isSameOriginPost(post({}), url)).toBe(false)
    })
})
