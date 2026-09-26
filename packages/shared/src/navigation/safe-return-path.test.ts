import { describe, expect, it } from 'vitest'
import { safeReturnPath } from './safe-return-path'

const fallback = '/account'

describe('safeReturnPath', () => {
    it('keeps a path on this origin, with its query and fragment', () => {
        expect(safeReturnPath('/billing?checkout=cancelled', fallback)).toBe('/billing?checkout=cancelled')
        expect(safeReturnPath('/g/abc/d/My%20Page#heading', fallback)).toBe('/g/abc/d/My%20Page#heading')
        expect(safeReturnPath('/', fallback)).toBe('/')
        // A dot segment that stays on this origin resolves rather than being refused.
        expect(safeReturnPath('/graphs/../account', fallback)).toBe('/account')
    })

    it('answers the fallback when nothing was asked for', () => {
        expect(safeReturnPath(null, fallback)).toBe(fallback)
        expect(safeReturnPath(undefined, fallback)).toBe(fallback)
        expect(safeReturnPath('', fallback)).toBe(fallback)
    })

    // Each of these reaches another host past a check of the raw string's prefix.
    it.each([
        ['an absolute URL', 'https://evil.example/phish'],
        ['a protocol-relative URL', '//evil.example/phish'],
        ['a relative path, which is not absolute', 'account'],
        ['a tab the URL parser strips', '/\t/evil.example/phish'],
        ['a line feed the URL parser strips', '/\n/evil.example/phish'],
        ['a carriage return the URL parser strips', '/\r/evil.example/phish'],
        ['a backslash browsers read as a slash', '/\\evil.example/phish'],
        ['a leading backslash', '\\\\evil.example/phish'],
        ['a percent-encoded tab', '/%09/evil.example/phish'],
        ['a percent-encoded backslash', '/%5Cevil.example/phish'],
        ['a percent-encoded slash', '/%2F/evil.example/phish'],
        ['another control character', '/\u0000/evil.example'],
        ['a dot segment that collapses to //', '/..//evil.example/phish'],
        ['a single-dot segment that collapses to //', '/.//evil.example/phish'],
        ['a nested dot segment that collapses to //', '/a/..//evil.example'],
        ['an encoded dot segment that collapses to //', '/%2e//evil.example/phish'],
        ['encoded double dots that collapse to //', '/%2E%2E//evil.example/phish'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a malformed percent escape', '/%E0%A4%A'],
    ])('refuses %s', (_label, value) => {
        expect(safeReturnPath(value, fallback)).toBe(fallback)
    })

    it('never returns a value a browser resolves off this origin', () => {
        const base = 'https://app.etherpk.com/login'
        for (const value of [
            '/\t/evil.example', '/\\evil.example', '/..//evil.example', '/%2F%2Fevil.example',
            '/./\t/evil.example', '/%0A/evil.example',
        ]) {
            expect(new URL(safeReturnPath(value, fallback), base).origin).toBe('https://app.etherpk.com')
        }
    })
})
