/**
 * Finding a postcode from the files EtherPK's map host serves (ADR 0119, amendment of 2026-10-09),
 * for everyone: one small file per Great Britain postcode district and per first three digits of a
 * US ZIP, built by `scripts/postcodes/build-postcodes.mjs`. A search reads the host's manifest once,
 * then the one file the postcode falls in, so it costs a cached fetch, needs no account and never
 * reaches the search service. The host sees only the district asked for.
 *
 * What is typed is read on the device (`recognisePostcode`): a full UK postcode, with or without
 * its space; a UK district on its own, which finds the district's middle; a ZIP+4; and a bare
 * five-digit number only when the browser's region is the United States, since five digits is a
 * postcode in 56 regions. A Northern Ireland postcode is recognised so the person can be told it is
 * not included: its points need a licence from Land and Property Services.
 *
 * The deployment names the host with `PUBLIC_POSTCODES_URL`: unset is EtherPK's, empty turns
 * postcode search off, and a URL names a self-hosted copy. Unset in development, it is the Client's
 * own origin, where `dev-postcodes-plugin.ts` serves the set `pnpm postcodes:build` built.
 */
import { dev } from '$app/environment'
import { env } from '$env/dynamic/public'

import type { PlaceSearchResult } from './map-block-services'

/** EtherPK's postcode files, when a deployment names none. */
const HOST = 'https://maps.etherpk.com/postcodes'
/** In development: the locally built set, which the development server serves. */
const DEV_HOST = '/dev-postcodes'

/** The files' format this Client reads (FORMAT in build-postcodes.mjs). */
const FORMAT = 1

/** Where the deployment's postcode files are, or null when it has none. */
export function postcodesUrl(value: string | undefined = env.PUBLIC_POSTCODES_URL, isDev = dev): string | null {
    if (value === undefined) return isDev ? DEV_HOST : HOST
    const url = value.trim()
    if (!url) return null
    try {
        return new URL(url).toString().replace(/\/+$/, '')
    } catch {
        return null
    }
}

/** A postcode as typed, read on the device: what the host's files can answer, or Northern Ireland's. */
export type PostcodeQuery =
    | { country: 'gb'; district: string; unit: string | null; label: string }
    | { country: 'us'; zip: string; label: string }
    | { country: 'northern-ireland'; label: string }

/** A postcode the host's files can answer. */
export type HostedPostcode = Exclude<PostcodeQuery, { country: 'northern-ireland' }>

/** The region a language tag names, such as `US` for `en-US`, or null when it names none. */
export function regionOf(language: string): string | null {
    try {
        return new Intl.Locale(language).region ?? null
    } catch {
        return null
    }
}

/** The postcode the text is, if it is one this Client recognises. `region` is the browser's. */
export function recognisePostcode(text: string, region: string | null): PostcodeQuery | null {
    const trimmed = text.trim()
    const compact = trimmed.replace(/\s+/g, '').toUpperCase()
    const full = /^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/.exec(compact)
    const outward = full ? full[1] : /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(compact) ? compact : null
    if (outward) {
        const label = full ? `${full[1]} ${full[2]}` : outward
        if (outward.startsWith('BT')) return { country: 'northern-ireland', label }
        return { country: 'gb', district: outward, unit: full ? full[2] : null, label }
    }
    const zipPlusFour = /^(\d{5})[-\s]?(\d{4})$/.exec(trimmed)
    if (zipPlusFour) return { country: 'us', zip: zipPlusFour[1], label: `${zipPlusFour[1]}-${zipPlusFour[2]}` }
    if (/^\d{5}$/.test(trimmed) && region === 'US') return { country: 'us', zip: trimmed, label: trimmed }
    return null
}

interface Manifest {
    format: number
    set: string
    countries: Record<string, unknown>
}

interface PostcodeFile {
    areas: string[]
    /** Each postcode's latitude, longitude and the index of its area in `areas`. */
    postcodes: Record<string, [number, number, number]>
    /** A district's middle and its area, for a search by district alone. */
    centre?: [number, number]
    area?: number
}

const UNREACHABLE = "The postcode lookup didn't answer. Check your connection, then try again."
const UNREADABLE = "The postcode lookup isn't answering properly. Try again in a moment, or type the coordinates."

export interface PostcodeLookup {
    /**
     * The place a postcode names, or null when the files hold no such postcode. Throws, with a
     * sentence to show, when the files cannot be read.
     */
    find(postcode: HostedPostcode): Promise<PlaceSearchResult | null>
}

/** A lookup over the postcode files at `baseUrl`, each file fetched once a session. */
export function createPostcodeLookup(baseUrl: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): PostcodeLookup {
    let manifest: Promise<Manifest> | null = null
    const files = new Map<string, Promise<PostcodeFile | null>>()

    /** The JSON at `url`, or null when the host has no such file. */
    async function json(url: string): Promise<unknown> {
        let response: Response
        try {
            response = await fetcher(url, { headers: { Accept: 'application/json' } })
        } catch {
            throw new Error(UNREACHABLE)
        }
        if (response.status === 404 || response.status === 403) return null
        if (!response.ok) throw new Error(UNREADABLE)
        return response.json().catch(() => {
            throw new Error(UNREADABLE)
        })
    }

    function readManifest(): Promise<Manifest> {
        manifest ??= json(`${baseUrl}/manifest.json`).then((body) => {
            const read = body as Partial<Manifest> | null
            if (!read || typeof read.set !== 'string' || !/^\d{4}-\d{2}$/.test(read.set) || typeof read.countries !== 'object' || read.countries === null) {
                throw new Error(UNREADABLE)
            }
            if (read.format !== FORMAT) throw new Error('The postcode files here are newer than this app reads. Reload the app to update it.')
            return read as Manifest
        })
        // A failed read is tried again at the next search.
        manifest.catch(() => (manifest = null))
        return manifest
    }

    function readFile(url: string): Promise<PostcodeFile | null> {
        let file = files.get(url)
        if (!file) {
            file = json(url).then((body) => {
                const read = body as Partial<PostcodeFile> | null
                if (read === null) return null
                if (!Array.isArray(read.areas) || typeof read.postcodes !== 'object' || read.postcodes === null) throw new Error(UNREADABLE)
                return read as PostcodeFile
            })
            files.set(url, file)
            file.catch(() => files.delete(url))
        }
        return file
    }

    return {
        async find(postcode) {
            const { set, countries } = await readManifest()
            if (!(postcode.country in countries)) return null
            const name = postcode.country === 'gb' ? postcode.district : postcode.zip.slice(0, 3)
            const file = await readFile(`${baseUrl}/${set}/${postcode.country}/${encodeURIComponent(name)}.json`)
            if (!file) return null
            if (postcode.country === 'gb' && postcode.unit === null) {
                if (!file.centre) return null
                return { name: postcode.label, detail: file.areas[file.area ?? 0] ?? '', point: { lat: file.centre[0], lon: file.centre[1] } }
            }
            const entry = file.postcodes[postcode.country === 'gb' ? (postcode.unit ?? '') : postcode.zip.slice(3)]
            if (!entry) return null
            const [lat, lon, area] = entry
            const label = postcode.country === 'gb' ? postcode.label : postcode.zip
            return { name: label, detail: file.areas[area] ?? '', point: { lat, lon }, postcode: label }
        },
    }
}
