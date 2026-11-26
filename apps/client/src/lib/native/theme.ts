/**
 * The theme in a Native App: kept by the page, and shown to the shell so that the window's frame
 * or the phone's bars match.
 *
 * A browser keeps the theme in a cookie, which the Client's server reads to draw the first page in it.
 * A Native App has no server, and its address may be one that keeps no cookies, so it is kept in
 * the page's own storage as well. The script in `app.html` reads it there before the first paint.
 */
import { getAppliedResolvedTheme, getAppliedThemePreference, THEME_CHANGE_EVENT, THEME_COOKIE_NAME } from '@appsoftwareltd/etherpk-shared/theme'

import { nativeBridge } from './bridge.js'

/** Where the preference is kept. `app.html` reads the same key. */
export const THEME_STORAGE_KEY = THEME_COOKIE_NAME

/** Keep the theme, and show it to the shell, now and at each change. Does nothing in a browser. */
export function watchTheme(): () => void {
    const bridge = nativeBridge()
    if (!bridge) return () => {}
    const show = () => {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, getAppliedThemePreference())
        } catch {
            // Storage refused: the theme is the system's at the next start, which is where it begins.
        }
        bridge.call('shell.setTheme', { scheme: getAppliedResolvedTheme() }).catch((error: unknown) => console.warn('[native] the shell did not take the theme', error))
    }
    show()
    window.addEventListener(THEME_CHANGE_EVENT, show)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, show)
}
