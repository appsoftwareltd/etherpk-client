import { describe, expect, it } from 'vitest'
import { safeReturnPath } from './safe-return-path'
import { signInPath } from './sign-in-path'

describe('signInPath', () => {
    it('returns to the page it was built on, query included', () => {
        expect(signInPath({ pathname: '/account/tokens', search: '?tab=agents' }))
            .toBe('/login?redirect=%2Faccount%2Ftokens%3Ftab%3Dagents')
    })

    it('hands the sign-in page a return path its own check accepts unchanged', () => {
        const here = { pathname: '/account', search: '?a=1&b=two words' }
        const redirect = new URL(signInPath(here), 'http://example.test').searchParams.get('redirect')
        expect(safeReturnPath(redirect, '/fallback')).toBe('/account?a=1&b=two%20words')
    })
})
