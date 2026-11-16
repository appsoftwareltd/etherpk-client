import { describe, expect, it } from 'vitest'

import {
    THEME_COOKIE_NAME,
    normalizeThemePreference,
    readThemeHandoff,
    resolveTheme,
    serializeThemeCookie,
    withThemeHandoff,
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

    // Each app keeps the theme in a cookie of its own host, so a link to another of the
    // deployment's apps carries it in the fragment.
    describe('the theme a link carries to another app', () => {
        const siblings = ['https://app.example.com/graphs', null, 'https://sync.example.com/']
        const here = 'https://www.example.com'

        it('adds the theme to a link that leads to another of the deployment\'s apps', () => {
            expect(withThemeHandoff('https://app.example.com/graphs', 'dark', siblings, here))
                .toBe('https://app.example.com/graphs#theme=dark')
            expect(withThemeHandoff('https://sync.example.com/account/tokens?tab=one', 'system', siblings, here))
                .toBe('https://sync.example.com/account/tokens?tab=one#theme=system')
        })

        it('replaces a theme the link already carries, so a change of the toggle is not lost', () => {
            expect(withThemeHandoff('https://app.example.com/graphs#theme=dark', 'light', siblings, here))
                .toBe('https://app.example.com/graphs#theme=light')
        })

        it('leaves alone a link on this origin, one that leaves the deployment, and one with its own fragment', () => {
            expect(withThemeHandoff('https://www.example.com/account', 'dark', siblings, here)).toBeNull()
            expect(withThemeHandoff('https://docs.example.org/', 'dark', siblings, here)).toBeNull()
            expect(withThemeHandoff('https://app.example.com/graphs#section', 'dark', siblings, here)).toBeNull()
            expect(withThemeHandoff('mailto:someone@example.com', 'dark', siblings, here)).toBeNull()
            expect(withThemeHandoff('not a url', 'dark', siblings, here)).toBeNull()
            // An app is never its own sibling, even when a list names it.
            expect(withThemeHandoff('https://app.example.com/graphs', 'dark', siblings, 'https://app.example.com')).toBeNull()
        })

        it('reads the theme back from the fragment, and nothing else', () => {
            expect(readThemeHandoff('#theme=dark')).toBe('dark')
            expect(readThemeHandoff('#theme=light')).toBe('light')
            expect(readThemeHandoff('#theme=system')).toBe('system')
            expect(readThemeHandoff('#theme=sepia')).toBeNull()
            expect(readThemeHandoff('#section')).toBeNull()
            expect(readThemeHandoff('')).toBeNull()
        })
    })
})
