/**
 * What an open window does with a launch the browser hands it through `launchQueue`, under the
 * manifest's `launch_handler: focus-existing`: the browser focuses the window already open
 * instead of opening another, and passes the launch's address.
 *
 * - A plain launch (the app icon) leaves the person where they were.
 * - A shortcut (`?shortcut=`) or a share (`/share`) is carried out in this window, by navigating
 *   to its address as the launch would have.
 * - A link into a graph (a workspace address, ADR 0192) is opened in this window: a person who
 *   pressed a link to a page expects that page, not the app as they left it.
 * - A file opened from the device's file manager lands on `/open-file`, which shows it.
 * - The launch that opened this page arrives too, and is ignored: the page already carried it out.
 */

import { SHORTCUT_PARAM } from '#lib/navigation/launch-shortcuts.js'
import { isAppPagePath } from '#lib/offline/app-shell.js'

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
    if (url.searchParams.has(SHORTCUT_PARAM) || url.pathname === '/share' || url.pathname === '/open-file') return `${url.pathname}${url.search}`
    // The fragment goes too: a link to a task carries the task there.
    return isWorkspaceAddress(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : null
}

/** A workspace address: an app page that is not the root resolver, the Graphs page or the Share Target. */
export function isWorkspaceAddress(pathname: string): boolean {
    return isAppPagePath(pathname) && !['/', '/graphs', '/share', '/open-file'].includes(pathname)
}
