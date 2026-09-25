import { describe, expect, it } from 'vitest'

import {
    THEME_COOKIE_NAME,
    normalizeThemePreference,
    resolveTheme,
    serializeThemeCookie,
} from './theme'

describe('theme utilities', () => {
    it('normalises missing or invalid preference values to system', () => {
        expect(normalizeThemePreference(undefined)).toBe('system')
        expect(normalizeThemePreference(null)).toBe('system')
        expect(normalizeThemePreference('')).toBe('system')
        expect(normalizeThemePreference('sepia')).toBe('system')
    })

    it('accepts the supported preference values', () => {
        expect(normalizeThemePreference('system')).toBe('system')
        expect(normalizeThemePreference('light')).toBe('light')
        expect(normalizeThemePreference('dark')).toBe('dark')
    })

    it('resolves system preference from the OS color scheme', () => {
        expect(resolveTheme('system', true)).toBe('dark')
        expect(resolveTheme('system', false)).toBe('light')
    })

    it('preserves explicit light and dark preferences', () => {
        expect(resolveTheme('light', true)).toBe('light')
        expect(resolveTheme('light', false)).toBe('light')
        expect(resolveTheme('dark', true)).toBe('dark')
        expect(resolveTheme('dark', false)).toBe('dark')
    })

    it('serialises the cookie with the expected persistence contract', () => {
        expect(serializeThemeCookie('dark')).toContain(`${THEME_COOKIE_NAME}=dark`)
        expect(serializeThemeCookie('dark')).toContain('Path=/')
        expect(serializeThemeCookie('dark')).toContain('Max-Age=31536000')
        expect(serializeThemeCookie('dark')).toContain('SameSite=Lax')
    })
})