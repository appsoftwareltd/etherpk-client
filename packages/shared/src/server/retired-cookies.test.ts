import { describe, expect, it, vi } from 'vitest'
import { clearRetiredCookies, RETIRED_COOKIE_NAMES } from './retired-cookies'

function fakeCookies(present: Record<string, string>) {
    return {
        get: vi.fn((name: string) => present[name]),
        delete: vi.fn(),
    }
}

// Neither Corporate nor the Sync Server sets `_s`, a 90-day attribution cookie. A copy left in
// a visitor's browser is removed on their next request rather than left to expire.
describe('clearRetiredCookies', () => {
    it('names the attribution cookie', () => {
        expect(RETIRED_COOKIE_NAMES).toContain('_s')
    })

    it('deletes the attribution cookie when the browser still sends it', () => {
        const cookies = fakeCookies({ _s: 'abc.def.012' })
        clearRetiredCookies(cookies)
        expect(cookies.delete).toHaveBeenCalledWith('_s', { path: '/' })
    })

    it('sends no Set-Cookie when there is nothing to clear', () => {
        const cookies = fakeCookies({ 'etherpk-theme': 'dark' })
        clearRetiredCookies(cookies)
        expect(cookies.delete).not.toHaveBeenCalled()
    })
})
