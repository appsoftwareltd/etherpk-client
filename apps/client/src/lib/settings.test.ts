import { describe, expect, it } from 'vitest'

import {
    DEFAULT_SETTINGS,
    SETTINGS_COOKIE_NAME,
    parseSettings,
    readSettingsFromCookieHeader,
    serializeSettingsCookie,
    serializeSettingsValue,
    withSidebarCollapsed,
} from './settings'

describe('client settings', () => {
    it('falls back to defaults for missing or malformed input', () => {
        expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS)
        expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
        expect(parseSettings('')).toEqual(DEFAULT_SETTINGS)
        expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS)
        expect(parseSettings('[1,2,3]')).toEqual(DEFAULT_SETTINGS)
    })

    it('reads known fields and ignores unknown ones', () => {
        const value = serializeSettingsValue({ leftSidebarCollapsed: true, rightSidebarCollapsed: false })
        const parsed = parseSettings(`${value.slice(0, -1)},"density":"cosy"}`)
        expect(parsed.leftSidebarCollapsed).toBe(true)
        expect(parsed.rightSidebarCollapsed).toBe(false)
    })

    it('round-trips through serialize/parse', () => {
        const settings = { leftSidebarCollapsed: true, rightSidebarCollapsed: true }
        expect(parseSettings(serializeSettingsValue(settings))).toEqual(settings)
    })

    it('serialises a cookie with the persistence contract', () => {
        const cookie = serializeSettingsCookie(DEFAULT_SETTINGS)
        expect(cookie).toContain(`${SETTINGS_COOKIE_NAME}=`)
        expect(cookie).toContain('Path=/')
        expect(cookie).toContain('Max-Age=31536000')
        expect(cookie).toContain('SameSite=Lax')
    })

    it('updates a single sidebar immutably with withSidebarCollapsed', () => {
        const next = withSidebarCollapsed(DEFAULT_SETTINGS, 'left', true)
        expect(next.leftSidebarCollapsed).toBe(true)
        expect(next.rightSidebarCollapsed).toBe(false)
        expect(DEFAULT_SETTINGS.leftSidebarCollapsed).toBe(false) // unchanged
    })

    it('extracts the settings cookie out of a request Cookie header', () => {
        const value = serializeSettingsValue({ leftSidebarCollapsed: true, rightSidebarCollapsed: false })
        const header = `etherpk-theme=dark; ${SETTINGS_COOKIE_NAME}=${encodeURIComponent(value)}; other=1`
        expect(readSettingsFromCookieHeader(header)).toEqual({
            leftSidebarCollapsed: true,
            rightSidebarCollapsed: false,
        })
    })

    it('returns defaults when the header has no settings cookie', () => {
        expect(readSettingsFromCookieHeader('etherpk-theme=dark')).toEqual(DEFAULT_SETTINGS)
        expect(readSettingsFromCookieHeader(null)).toEqual(DEFAULT_SETTINGS)
    })
})
