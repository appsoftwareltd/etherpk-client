/**
 * Addresses EtherPK writes into a document or hands to someone else. In a browser they are the
 * Client's own. A Native App's own addresses (`app://etherpk`, an https origin answered inside the
 * app) lead nowhere outside it, so it writes the web Client's, where its build names one
 * (`INSTALLED_WEB_CLIENT_URL`), and otherwise no address.
 */
import { ETHERPK_LINK_SCHEME } from '@appsoftwareltd/etherpk-native-bridge'

import type { AddressPlace } from '#lib/navigation/page-address.js'

import { isNativeApp } from './bridge.js'

/** The origin of a web Client a person can open anywhere, or null where there is none to name. */
export function webClientOrigin(): string | null {
    if (isNativeApp()) return __INSTALLED_BUILD__?.webClientUrl ?? null
    return typeof location === 'undefined' ? null : location.origin
}

/** A page of the web Client, or null where there is none to name. */
export function webClientAddress(path: string): string | null {
    const origin = webClientOrigin()
    return origin === null ? null : new URL(path, `${origin}/`).href
}

/**
 * An address of this app that the person can open from another program, such as an agent's terminal:
 * the web address in a browser, and an `etherpk:` link that opens the Native App (`launches.ts`).
 */
export function openingAddress(path: string): string {
    return isNativeApp() ? `${ETHERPK_LINK_SCHEME}:${path}` : `${location.origin}${path}`
}

/** Where the app is running, as the page address reads and writes addresses (`navigation/page-address.ts`). */
export function addressPlace(): AddressPlace {
    const native = isNativeApp()
    return { origin: location.origin, webOrigin: native ? webClientOrigin() : null, native }
}
