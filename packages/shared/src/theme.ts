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

/**
 * The name a link to another EtherPK app carries the theme under, as its fragment:
 * `https://app.example.com/graphs#theme=dark`.
 *
 * Each app keeps the theme in a cookie of its own host, so the Client, the Sync Server and the
 * account site would otherwise each remember a different one. A fragment is never sent to a
 * server and survives the redirects of a sign-in, and each app's `app.html` reads it before the
 * first paint, stores it in its own cookie and takes it off the address.
 */
export const THEME_HANDOFF_KEY = 'theme'

/** The theme a fragment hands over (`#theme=dark`), or null when it is anything else. */
export function readThemeHandoff(hash: string): ThemePreference | null {
    const prefix = `#${THEME_HANDOFF_KEY}=`
    if (!hash.startsWith(prefix)) return null
    const value = hash.slice(prefix.length)
    return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : null
}

/**
 * `href` with the theme in its fragment, when it leads to one of the deployment's other apps
 * (`siblingUrls`: any address on each of them; null entries are apps this deployment lacks).
 * Null when the link is left alone: it stays on this origin, leaves the deployment, is not a
 * web address, or has a fragment of its own to keep.
 */
export function withThemeHandoff(
    href: string,
    preference: ThemePreference,
    siblingUrls: ReadonlyArray<string | null | undefined>,
    currentOrigin: string,
): string | null {
    const url = parseUrl(href)
    if (!url || url.origin === currentOrigin) return null
    if (!siblingUrls.some((sibling) => sibling && parseUrl(sibling)?.origin === url.origin)) return null
    // A fragment that is not an earlier handoff means something to the page it leads to.
    if (url.hash && readThemeHandoff(url.hash) === null) return null
    url.hash = `${THEME_HANDOFF_KEY}=${preference}`
    return url.href
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value)
    } catch {
        return null
    }
}

/**
 * Give the link under a click or a press the current theme to carry, when it leads to another
 * of the deployment's apps. Each app's root layout listens with this on the document for
 * `pointerdown` (which comes before a middle click or a context menu opens the link in a new
 * tab) and `click` (a keyboard activation has no pointer), so every link is covered wherever
 * it is rendered, and the theme is read at the moment of use, after any change of the toggle.
 */
export function carryThemeToSiblingApp(
    event: Event,
    siblingUrls: ReadonlyArray<string | null | undefined>,
): void {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(link instanceof HTMLAnchorElement)) return
    const href = withThemeHandoff(link.href, getAppliedThemePreference(), siblingUrls, location.origin)
    if (href && href !== link.href) link.href = href
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