/**
 * The pages a Native App has. It holds the app and none of the Client's public pages, which a
 * server renders and whose links lead to the website instead.
 */
import { isNativeApp } from './bridge.js'
import { isAppPagePath } from '#lib/offline/app-shell.js'

/** Where a Native App starts, and where it goes in place of a page it does not have. */
export const GRAPHS_PATH = '/graphs'

/** App pages a Native App opens that a service worker does not answer with its kept page. */
const OTHER_PAGES = new Set(['/demo', '/extension-sign-in'])

/** Whether a navigation leads to a page of this origin that a Native App does not hold. Never in a browser. */
export function leadsToAbsentPage(url: URL): boolean {
    return isNativeApp() && url.href.startsWith(`${location.origin}/`) && !isInstalledAppPage(url.pathname)
}

/** Whether a Native App can show the page at this path. */
export function isInstalledAppPage(pathname: string): boolean {
    return isAppPagePath(pathname) || OTHER_PAGES.has(pathname)
}
