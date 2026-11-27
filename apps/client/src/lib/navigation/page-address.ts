/**
 * The address of the page a person is on, as they copy it, read it and type it (CONTEXT.md:
 * **Document URL**, **EtherPK Link**).
 *
 * An installed web app and a Native App show no address bar, so the workspace shows the address
 * itself (`PageAddressField.svelte`). This module is everything about that address that is not
 * drawing it:
 *
 * - **The link a person copies.** In a browser and an installed web app it is the web address. A
 *   Native App's own address (`app://etherpk`, or an https origin the app answers itself) leads
 *   nowhere outside it, so it copies an EtherPK Link, `etherpk:` and the path, which the system
 *   hands back to the app.
 * - **The web address a Native App offers beside it**, on a synced graph, where the build names a
 *   web Client. A folder graph or a graph kept inside the app is on no web Client.
 * - **The readable form**: escapes such as `%20` shown as the letters they stand for, except the
 *   few that would change where the address leads once it is read back.
 * - **Reading what a person typed or pasted** into a page's path, or a reason it leads nowhere.
 * - **The address in its workspace**: the part after the graph's or the Plain Folder's own address
 *   (`/d/Garden Beds`), which the workspace toolbar shows, and which reads back in that workspace.
 *
 * Pure: the caller says where the app is running (`AddressPlace`), so Node tests every case.
 */

import { ETHERPK_LINK_SCHEME } from '@appsoftwareltd/etherpk-native-bridge'

import { isWorkspaceAddress } from '#lib/install/launch-target.js'

import { parseGraphAddressPath } from './graph-address'

/** Where the app is running, as far as its addresses go. */
export interface AddressPlace {
    /** The app's own origin: `location.origin`. */
    origin: string
    /** In a Native App, the web Client its build names (`INSTALLED_WEB_CLIENT_URL`), whose pages are the app's too; otherwise null. */
    webOrigin: string | null
    /** A Native App, whose own address leads nowhere outside it. */
    native: boolean
}

export type AddressRefusal = 'empty' | 'not-a-page' | 'other-site'

export type AddressReading = { ok: true; path: string } | { ok: false; refusal: AddressRefusal }

/** What a refusal says, under the field. */
export const ADDRESS_REFUSAL_COPY: Record<AddressRefusal, string> = {
    empty: 'Type or paste an address.',
    'not-a-page': 'That address does not lead to a page in EtherPK.',
    'other-site': "That is another site's address. Open it in your browser.",
}

const SCHEME = `${ETHERPK_LINK_SCHEME}:`

/** A base for reading a path on its own; never shown, and never an address anything answers. */
const BASE = 'https://address.invalid'

/** The link a person copies for the page at `path` (a path, with any query and fragment). */
export function pageLink(path: string, place: AddressPlace): string {
    return place.native ? `${SCHEME}${path}` : `${place.origin}${path}`
}

/** The web address a Native App offers beside its link, or null where there is none to name. */
export function pageWebAddress(path: string, place: AddressPlace): string | null {
    if (!place.native || place.webOrigin === null) return null
    const pathname = new URL(path, BASE).pathname
    return parseGraphAddressPath(pathname)?.address.where === 'sync' ? `${place.webOrigin}${path}` : null
}

/**
 * A character that stays escaped when the address is shown: one that would change where the address
 * leads once it is read back (`%`, `/`, `?`, `#`, and `\`, which a web address reads as `/`), and
 * line breaks, tabs and other spaces than the plain one, which a paste loses or a person cannot see.
 */
const KEPT_ESCAPED = /[%/?#\\\p{Cc}]|(?! )\s/u

/** The address as a person reads it: `%20` shown as a space, `%C3%A9` as é. */
export function readableAddress(address: string): string {
    const shown = address.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        let text: string
        try {
            text = decodeURIComponent(run)
        } catch {
            // Not text: an escape the app never writes, left as it is.
            return run
        }
        return [...text].map((char) => (KEPT_ESCAPED.test(char) ? encodeURIComponent(char) : char)).join('')
    })
    // A space at the very end would be trimmed off when the address is read back.
    return shown.replace(/ +$/, (spaces) => '%20'.repeat(spaces.length))
}

/**
 * A workspace's own address at the start of a path: `/graph/<where>/<name>` for a graph (ADR 0192),
 * `/folder/<name>` for a Plain Folder (ADR 0194).
 */
const WORKSPACE_BASE = /^(?:\/graph\/(?:folder|sync|browser)|\/folder)\/[^/?#]+/

/** The address of the workspace a path is in (`/graph/sync/0f4e2a`), or null for a path that is in none. */
export function workspaceBase(path: string): string | null {
    return WORKSPACE_BASE.exec(path)?.[0] ?? null
}

/**
 * The address from the workspace's own address on, as the workspace toolbar shows it: `/d/Garden%20Beds`
 * for `/graph/sync/0f4e2a/d/Garden%20Beds`, with any query and fragment, and `/` for the workspace's
 * own page. Every page of a workspace starts the same, so the rest is what tells one from another.
 * A path that is in no workspace is returned whole.
 */
export function addressInWorkspace(path: string): string {
    const base = workspaceBase(path)
    if (base === null) return path
    const rest = path.slice(base.length)
    return rest.startsWith('/') ? rest : `/${rest}`
}

/** The app's own pages, which a path typed in a workspace names rather than a page of the workspace. */
const APP_PAGE = /^\/(?:graph|folder|g|graphs|share|open-file)(?:[/?#]|$)/

/**
 * The page's path a person's text leads to: an address of this app or of its web Client, an
 * EtherPK Link, a bare path, or text with an EtherPK Link in it, such as an Agent Instruction.
 * In a workspace (`base`, its own address), a path from that address on leads to a page of the
 * same workspace, as the toolbar shows it ({@link addressInWorkspace}).
 */
export function readAddress(input: string, place: AddressPlace, base: string | null = null): AddressReading {
    const text = input.trim()
    if (text === '') return { ok: false, refusal: 'empty' }
    if (base !== null && text.startsWith('/') && !/^\/[/\\]/.test(text) && !APP_PAGE.test(text)) return reading(pathOf(inWorkspace(base, text)))
    const whole = readOne(text, place)
    if (whole.ok) return whole
    // Text with a link in it: the first EtherPK Link that leads to a page. Only EtherPK Links, so an
    // Agent Instruction's own reference wins over the web address it ends with.
    for (const [link] of text.matchAll(/etherpk:[^\s)>\]"'`]+/gi)) {
        const found = etherpkLinkPath(link)
        if (found !== null) return { ok: true, path: found }
    }
    return whole
}

/**
 * The page's path an EtherPK Link names, or null for one that names no page a link may open.
 *
 * The link is a path under the scheme, as a Task Reference writes it (`etherpk:/graph/sync/<id>/d/…`).
 * A program that builds one by the rules of a web address writes two slashes, and a third for the
 * path, so those are read too. Any program can open a link, so it reaches only pages that show notes.
 */
export function etherpkLinkPath(link: string): string | null {
    const rest = /^etherpk:\/{0,3}([^/\\].*)$/i.exec(link.trim())?.[1]
    return rest === undefined ? null : pathOf(`/${rest}`)
}

function readOne(text: string, place: AddressPlace): AddressReading {
    if (/^etherpk:/i.test(text)) return reading(etherpkLinkPath(text))
    // A bare path, but never `//host/…`, which a web address reads as another site.
    if (text.startsWith('/')) return reading(/^\/[/\\]/.test(text) ? null : pathOf(text))
    const url = absolute(text, place)
    if (url === null) return { ok: false, refusal: 'not-a-page' }
    if (ownSite(url, place)) return reading(pathOf(`${url.pathname}${url.search}${url.hash}`))
    return { ok: false, refusal: url.protocol === 'http:' || url.protocol === 'https:' ? 'other-site' : 'not-a-page' }
}

/** The text as a full address, reading `host/…` as a browser's address bar does. */
function absolute(text: string, place: AddressPlace): URL | null {
    if (/^[a-z0-9.-]+(?::\d+)?\//i.test(text)) {
        // `localhost:5173/…` parses as a scheme of its own, so a host and a path are tried first.
        for (const scheme of ['https://', 'http://']) {
            const url = URL.canParse(`${scheme}${text}`) ? new URL(`${scheme}${text}`) : null
            if (url && ownSite(url, place)) return url
        }
    }
    return URL.canParse(text) ? new URL(text) : null
}

/** An address of this app, or of the web Client whose pages are the app's too. */
function ownSite(url: URL, place: AddressPlace): boolean {
    // By scheme and host, not `url.origin`, which is "null" for a scheme a web address does not know (`app:`).
    const site = `${url.protocol}//${url.host}`
    return [place.origin, place.webOrigin].some((origin) => origin !== null && site === origin.replace(/\/$/, ''))
}

/**
 * A path with any query and fragment, read against no site: each part of the path written as the app
 * writes it, whichever way it was escaped. Null for a path that shows no notes or has an escape that
 * is not text.
 */
function pathOf(path: string): string | null {
    if (!URL.canParse(path, BASE)) return null
    const url = new URL(path, BASE)
    if (url.origin !== BASE) return null
    let pathname: string
    try {
        pathname = url.pathname
            .split('/')
            .map((part) => encodeURIComponent(decodeURIComponent(part)))
            .join('/')
    } catch {
        return null
    }
    return isWorkspaceAddress(pathname) ? `${pathname}${url.search}${url.hash}` : null
}

/** A path from the workspace's own address on, put after that address: `/` is the workspace's own page. */
function inWorkspace(base: string, text: string): string {
    const cut = text.search(/[?#]/)
    const pathname = cut === -1 ? text : text.slice(0, cut)
    const tail = cut === -1 ? '' : text.slice(cut)
    return `${base}${pathname === '/' ? '' : pathname}${tail}`
}

function reading(path: string | null): AddressReading {
    return path === null ? { ok: false, refusal: 'not-a-page' } : { ok: true, path }
}
