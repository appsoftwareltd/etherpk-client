/**
 * What an open window does with a launch the browser hands it through `launchQueue`, under the
 * manifest's `launch_handler: focus-existing`: the browser focuses the window already open
 * instead of opening another, and passes the launch's address.
 *
 * - A plain launch (the app icon) leaves the person where they were.
 * - A shortcut (`?shortcut=`) or a share (`/share`) is carried out in this window, by navigating
 *   to its address as the launch would have.
 * - The launch that opened this page arrives too, and is ignored: the page already carried it out.
 */

import { SHORTCUT_PARAM } from '$lib/navigation/launch-shortcuts'

/** The address to navigate to, or null to stay. `openedHref` is the address the page was opened at. */
export function launchTarget(targetUrl: string | undefined, origin: string, openedHref: string): string | null {
    if (!targetUrl || targetUrl === openedHref) return null
    let url: URL
    try {
        url = new URL(targetUrl)
    } catch {
        return null
    }
    if (url.origin !== origin) return null
    const actionable = url.searchParams.has(SHORTCUT_PARAM) || url.pathname === '/share'
    return actionable ? `${url.pathname}${url.search}` : null
}
