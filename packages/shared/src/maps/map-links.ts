import { z } from 'zod'

/**
 * Shortened links to a place on another map (ADR 0119, amendment of 2026-10-10): which ones a
 * Client asks a Sync Server's `POST /api/v1/sync/maps/link` to open, and the only ones that server
 * opens.
 *
 * Google's Share gives a short link whose place is only in the address it redirects to. A browser
 * page cannot follow that redirect, because it carries no CORS header, so the Sync Server follows
 * it, reading each redirect's `Location` and never a page, and answers with the full link. It
 * follows these hosts and no others, so it can never be asked to fetch any address someone names.
 * OpenStreetMap's short links hold their position in the link itself, so a Client decodes those on
 * the device and never sends them.
 */

/** The most characters a short link may hold: Google's are about forty. */
export const MAP_LINK_MAX_LENGTH = 200

/** Why a Sync Server could not open a short link, as the `code` of its refusal. */
export const MAP_LINK_REFUSAL = {
    /** The link did not lead to a map link: it has expired, or was never one. */
    unreadable: 'map_link_unreadable',
} as const

/** Whether `text` is a short link a Sync Server opens: one of Google's share links. */
export function isShortMapLink(text: string): boolean {
    let url: URL
    try {
        url = new URL(text.trim())
    } catch {
        return false
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false
    const host = url.hostname.toLowerCase()
    if (host === 'maps.app.goo.gl') return /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    if (host === 'goo.gl') return /^\/maps\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    return false
}

export const mapLinkRequestSchema = z.strictObject({
    url: z.string().trim().max(MAP_LINK_MAX_LENGTH).refine(isShortMapLink, 'not a short map link'),
})

export type MapLinkRequest = z.infer<typeof mapLinkRequestSchema>

/** What a Sync Server answers: the full link the short one leads to, for the Client to read. */
export interface MapLinkResponse {
    url: string
}
