/**
 * Addresses outside the app, in a Native App: the system browser opens them, or the mail or phone
 * app for theirs. The app's own window never leaves the app, because a window that did would have no
 * address bar to come back with.
 *
 * In a browser every function here leaves the browser to do what it does.
 */
import { goto } from '$app/navigation'

import { showNotice } from '#lib/activity/notices.js'

import { nativePlatform, nativeBridge } from './bridge.js'

const OPENABLE = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** The address to hand to the system when a link to `href` is followed on a page of `origin`, or null for one the app follows itself. */
export function externalAddress(href: string, origin: string): string | null {
    if (!URL.canParse(href, `${origin}/`)) return null
    const url = new URL(href, `${origin}/`)
    if (!OPENABLE.has(url.protocol) || url.href === origin || url.href.startsWith(`${origin}/`)) return null
    return url.href
}

/** Open an address in the system browser, or in this browser's own tab where there is no shell. */
export function openExternal(url: string): void {
    const bridge = nativeBridge()
    if (!bridge) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return
    }
    bridge.call('shell.openExternal', { url }).catch((error: unknown) => {
        console.error('[native] an address could not be opened', error)
        showNotice({ id: 'open-external', tone: 'error', text: 'That address could not be opened. Copy the address, and open it in your browser.' })
    })
}

/** Go on to another of EtherPK's sites: this tab goes there, or the system browser opens it for a Native App. */
export function leaveFor(url: string): void {
    if (nativeBridge()) openExternal(url)
    else window.location.assign(url)
}

/**
 * Send every link out of the app to the system: links clicked, and windows opened by code. One place,
 * for the Client, its extensions and the libraries both use. Does nothing in a browser. Returns a
 * function that stops.
 */
export function watchExternalLinks(): () => void {
    if (!nativeBridge()) return () => {}
    const onClick = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest?.('a[href]')
        if (event.defaultPrevented || !(link instanceof HTMLAnchorElement) || link.hasAttribute('download')) return
        const external = externalAddress(link.href, location.origin)
        if (external) {
            event.preventDefault()
            openExternal(external)
        } else if (link.target === '_blank' && opensInPlace(link.href)) {
            event.preventDefault()
            void goto(link.href)
        }
    }
    // A middle click is a click here: it asks a browser for a new tab, and there are none.
    const onAuxClick = (event: MouseEvent) => {
        if (event.button === 1) onClick(event)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('auxclick', onAuxClick)
    const open = window.open
    window.open = (url, target, features) => {
        const href = String(url ?? '')
        const external = externalAddress(href, location.origin)
        if (external) openExternal(external)
        else if (opensInPlace(href)) void goto(href)
        else return open.call(window, url, target, features)
        // As a browser answers for a window opened with `noopener`.
        return null
    }
    return () => {
        document.removeEventListener('click', onClick)
        document.removeEventListener('auxclick', onAuxClick)
        window.open = open
    }
}

/** A page of the app's own asked for in a new window, on a phone, where the app has one. */
function opensInPlace(href: string): boolean {
    return nativePlatform() === 'android' && URL.canParse(href, `${location.origin}/`) && new URL(href, `${location.origin}/`).href.startsWith(`${location.origin}/`)
}
