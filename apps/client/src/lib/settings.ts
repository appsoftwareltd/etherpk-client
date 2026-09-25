/**
 * Chrome settings — small, per-device UI preferences persisted to a cookie so
 * they are available during SSR and never flash on first paint. This is the
 * same pattern as {@link ./theme.ts}, generalised to a typed, growable record
 * (decision #1). Theme keeps its own dedicated cookie for now; new chrome
 * settings (sidebar-collapsed, and later density, …) live here and are additive.
 *
 * The {@link LayoutController} is the source of truth for sidebar visibility;
 * the `*SidebarCollapsed` fields here are a *mirror* it writes on toggle and
 * the server reads to render the correct collapsed state without a flash.
 */

import type { SidebarSide } from './layout/types'

export const SETTINGS_COOKIE_NAME = 'etherpk-settings'
export const SETTINGS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export interface ClientSettings {
    leftSidebarCollapsed: boolean
    rightSidebarCollapsed: boolean
    // Additive: density, etc. join here without a new cookie or read site.
}

export const DEFAULT_SETTINGS: ClientSettings = {
    leftSidebarCollapsed: false,
    rightSidebarCollapsed: false,
}

/** Coerce arbitrary parsed JSON into a valid {@link ClientSettings}. */
function coerce(record: Record<string, unknown>): ClientSettings {
    return {
        leftSidebarCollapsed: record.leftSidebarCollapsed === true,
        rightSidebarCollapsed: record.rightSidebarCollapsed === true,
    }
}

/**
 * Parse a cookie *value* into settings, tolerating anything malformed by
 * returning the defaults — a corrupt cookie must never break a render.
 */
export function parseSettings(value: string | null | undefined): ClientSettings {
    if (!value) return { ...DEFAULT_SETTINGS }
    try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ...DEFAULT_SETTINGS }
        }
        return coerce(parsed as Record<string, unknown>)
    } catch {
        return { ...DEFAULT_SETTINGS }
    }
}

/** Serialise settings to a compact cookie value (JSON). */
export function serializeSettingsValue(settings: ClientSettings): string {
    return JSON.stringify(settings)
}

/** Serialise the full `Set-Cookie` string with the persistence contract. */
export function serializeSettingsCookie(settings: ClientSettings): string {
    const value = encodeURIComponent(serializeSettingsValue(settings))
    return `${SETTINGS_COOKIE_NAME}=${value}; Path=/; Max-Age=${SETTINGS_COOKIE_MAX_AGE}; SameSite=Lax`
}

/** Immutably set one sidebar's collapsed state. */
export function withSidebarCollapsed(
    settings: ClientSettings,
    side: SidebarSide,
    collapsed: boolean,
): ClientSettings {
    const field = side === 'left' ? 'leftSidebarCollapsed' : 'rightSidebarCollapsed'
    return { ...settings, [field]: collapsed }
}

/** Read the current settings from `document.cookie` (client-side). */
export function readSettingsFromDocument(): ClientSettings {
    if (typeof document === 'undefined') return { ...DEFAULT_SETTINGS }
    return readSettingsFromCookieHeader(document.cookie)
}

/** Persist settings to `document.cookie` (client-side). */
export function writeSettingsToDocument(settings: ClientSettings): void {
    if (typeof document === 'undefined') return
    document.cookie = serializeSettingsCookie(settings)
}

/** Extract and parse the settings cookie from a request `Cookie` header. */
export function readSettingsFromCookieHeader(header: string | null | undefined): ClientSettings {
    if (!header) return { ...DEFAULT_SETTINGS }
    const match = header
        .split(';')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${SETTINGS_COOKIE_NAME}=`))
    if (!match) return { ...DEFAULT_SETTINGS }
    const raw = match.slice(SETTINGS_COOKIE_NAME.length + 1)
    return parseSettings(decodeURIComponent(raw))
}
