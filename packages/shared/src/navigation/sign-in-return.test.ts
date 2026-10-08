import { describe, expect, it } from 'vitest'
import { pathWithQuery, signInReturnPath, SIGN_IN_RETURN_PARAMETER } from './sign-in-return'

describe('signInReturnPath', () => {
    it('returns to the page the sign-in started on, with its query', () => {
        expect(signInReturnPath({ pathname: '/pricing', search: '?plan=sync-plus' }, '/account'))
            .toBe('/pricing?plan=sync-plus')
        expect(signInReturnPath({ pathname: '/contact', search: '' }, '/dashboard')).toBe('/contact')
    })

    it("sends a page that only makes sense signed out to the app's signed-in home", () => {
        for (const pathname of ['/', '/home', '/marketing', '/login', '/register', '/forgot-password', '/reset-password', '/auth-error']) {
            expect(signInReturnPath({ pathname, search: '?managed=signed-out' }, '/account'), pathname).toBe('/account')
        }
    })
})

describe('pathWithQuery', () => {
    it('adds a query only when there is one', () => {
        expect(pathWithQuery('/login', '')).toBe('/login')
        expect(pathWithQuery('/login', null)).toBe('/login')
        expect(pathWithQuery('/login', 'redirect=%2Fpricing')).toBe('/login?redirect=%2Fpricing')
        expect(pathWithQuery('/login', new URLSearchParams({ redirect: '/pricing' }))).toBe('/login?redirect=%2Fpricing')
    })
})

describe('SIGN_IN_RETURN_PARAMETER', () => {
    // The Client, the Sync portal and Corporate all name it, so a rename must reach all three.
    it('is the name the apps and Corporate agree on', () => {
        expect(SIGN_IN_RETURN_PARAMETER).toBe('etherpk_return')
    })
})
