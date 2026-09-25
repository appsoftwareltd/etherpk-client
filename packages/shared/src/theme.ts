export const THEME_COOKIE_NAME = 'etherpk-theme'
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
export const THEME_CHANGE_EVENT = 'gkthemechange'

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = 'light' | 'dark'

export function normalizeThemePreference(value: string | null | undefined): ThemePreference {
    return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
    if (preference === 'system') {
        return systemPrefersDark ? 'dark' : 'light'
    }

    return preference
}

export function serializeThemeCookie(preference: ThemePreference): string {
    return `${THEME_COOKIE_NAME}=${preference}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`
}

export function decorateHtmlWithTheme(
    html: string,
    preference: ThemePreference,
    resolvedTheme: ResolvedTheme,
): string {
    const classAttribute = resolvedTheme === 'dark' ? ' class="dark"' : ''

    return html.replace(
        '<html lang="en">',
        `<html lang="en" data-theme-preference="${preference}" data-theme="${resolvedTheme}"${classAttribute}>`,
    )
}

export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
    const normalizedPreference = normalizeThemePreference(preference)
    const root = document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const resolvedTheme = resolveTheme(normalizedPreference, mediaQuery.matches)

    root.dataset.themePreference = normalizedPreference
    root.dataset.theme = resolvedTheme
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
    document.cookie = serializeThemeCookie(normalizedPreference)
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
        detail: {
            preference: normalizedPreference,
            resolvedTheme,
        },
    }))

    return resolvedTheme
}

export function getAppliedThemePreference(): ThemePreference {
    if (typeof document === 'undefined') {
        return 'system'
    }

    return normalizeThemePreference(document.documentElement.dataset.themePreference)
}

export function getAppliedResolvedTheme(): ResolvedTheme {
    if (typeof document === 'undefined') {
        return 'light'
    }

    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}