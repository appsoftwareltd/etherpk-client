/**
 * Searching for a place by name, address or postcode from a [[Map Block]] (ADR 0119).
 *
 * The search runs on a Sync Server, which decides whether the account may search (it comes with
 * Sync+ on Managed Sync) and which service answers: the open graph's own server, or for a graph
 * kept on this device, the device's main connection. A deployment may instead name a Photon
 * server the Client asks directly (`PUBLIC_PLACE_SEARCH_URL`), which needs no account at all.
 *
 * Either way the answer is in Photon's form, read here into the rows the Map Block offers, with
 * the credits the service asks for, which the Map Block shows under them: what the Sync Server
 * sends, or OpenStreetMap's for a Photon server and for a server that sends none, since every
 * service EtherPK uses is built on OpenStreetMap's data. Every refusal becomes a sentence saying
 * what to do instead, which the Map Block shows under its search box, and coordinates, Plus Codes
 * and map links keep working whatever the answer.
 */
import {
    OPENSTREETMAP_CREDIT,
    PLACE_SEARCH_MAX_RESULTS,
    PLACE_SEARCH_REFUSAL,
    type PlaceSearchCredit,
    type PlaceSearchFeature,
    readPlaceCredits,
    readPlaceFeatures,
} from '@appsoftwareltd/etherpk-shared'

import type { MapPoint } from '$lib/document/map-text'
import { SyncApiError, type SyncApi } from '$lib/sync/sync-api'

import type { PlaceSearch, PlaceSearchResult } from './map-block-services'

/** What a service answered: the places, and the credits it asks for. */
interface Found {
    features: PlaceSearchFeature[]
    credits: PlaceSearchCredit[]
}

/** What a person can always do instead of searching by name. */
const INSTEAD = 'Type coordinates such as 50.7486, -1.0789, a Plus Code, or paste a link from Google Maps, Apple Maps or OpenStreetMap.'

/** A Sync Server to search through. */
export interface PlaceSearchServer {
    /** The server's origin, which names it in what the person is told. */
    origin: string
    api: Pick<SyncApi, 'searchPlaces'>
}

export interface PlaceSearchOptions {
    /** The server to ask now: the open graph's own, or the device's main connection; null for none. */
    server(): PlaceSearchServer | null
    /** A Photon search API the deployment names, asked directly; null for none. */
    photonUrl: string | null
    /** Whether this deployment offers Managed Sync, so someone without a server is told of Sync+. */
    offersSyncPlus: boolean
    /** The reader's language, such as `en-GB`, for the names of places. */
    language(): string
    fetch?: typeof fetch
}

/**
 * A full UK postcode, written without spaces in capitals, or null for anything else. A search
 * for one keeps only the places that have it: a postcode is a precise address, and a geocoder
 * that cannot find it answers with its neighbours.
 */
export function ukPostcode(text: string): string | null {
    const compact = text.replace(/\s+/g, '').toUpperCase()
    return /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact) ? compact : null
}

/** The places found, as the Map Block lists them. */
export function placeResults(features: readonly PlaceSearchFeature[], query: string): PlaceSearchResult[] {
    const results = features.map((feature): PlaceSearchResult => {
        const p = feature.properties
        const [lon, lat] = feature.geometry.coordinates
        const street = [p.housenumber, p.street].filter(Boolean).join(' ')
        const name = p.name ?? (street || p.postcode || p.city || p.district || p.county || p.state || p.country || 'Unnamed place')
        // The county only where there is no town to name: "Ventnor, Isle of Wight", not "London, Greater London".
        const detail = [...new Set([street, p.district, p.city ?? p.county, p.postcode, p.state, p.country])].filter((part) => part && part !== name).join(', ')
        return { name, detail, point: { lat, lon }, postcode: p.postcode }
    })
    const postcode = ukPostcode(query)
    if (!postcode) return results
    return results.filter((result) => result.postcode !== undefined && ukPostcode(result.postcode) === postcode)
}

function host(origin: string): string {
    try {
        return new URL(origin).host
    } catch {
        return origin
    }
}

function aborted(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
}

/** What a server's refusal tells the person to do. */
function refusalMessage(error: unknown, server: string): string {
    if (error instanceof SyncApiError) {
        if (error.code === PLACE_SEARCH_REFUSAL.plan) return `Searching by name comes with Sync+. ${INSTEAD}`
        if (error.code === PLACE_SEARCH_REFUSAL.off) return `${server} doesn't search for places by name. ${INSTEAD}`
        if (error.status === 429) return 'Too many searches. Wait a minute, then try again.'
        if (error.status === 401) return `Sign in to ${server} again to search for places by name.`
        return "The place search isn't answering. Try again in a moment, or type the coordinates."
    }
    return `The search didn't reach ${server}. Check your connection, then try again.`
}

export function createPlaceSearch(options: PlaceSearchOptions): PlaceSearch {
    const fetcher = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
    const lang = () => {
        const code = options.language().slice(0, 2).toLowerCase()
        return /^[a-z]{2}$/.test(code) ? code : undefined
    }

    async function viaPhoton(url: string, query: string, near: MapPoint | null, signal: AbortSignal): Promise<Found> {
        const asked = new URL(url)
        asked.searchParams.set('q', query)
        asked.searchParams.set('limit', String(PLACE_SEARCH_MAX_RESULTS))
        if (near) {
            asked.searchParams.set('lat', String(near.lat))
            asked.searchParams.set('lon', String(near.lon))
        }
        const language = lang()
        if (language) asked.searchParams.set('lang', language)
        let response: Response
        try {
            response = await fetcher(asked.toString(), { headers: { Accept: 'application/json' }, signal })
        } catch (error) {
            if (aborted(error)) throw error
            throw new Error("The search didn't reach the place search service. Check your connection, then try again.")
        }
        const body = response.ok ? ((await response.json().catch(() => null)) as { features?: unknown } | null) : null
        if (!body || !Array.isArray(body.features)) throw new Error("The place search isn't answering. Try again in a moment, or type the coordinates.")
        return { features: readPlaceFeatures(body.features), credits: [OPENSTREETMAP_CREDIT] }
    }

    async function viaServer(server: PlaceSearchServer, query: string, near: MapPoint | null, signal: AbortSignal): Promise<Found> {
        try {
            const language = lang()
            const answer = await server.api.searchPlaces({ q: query, ...(near ? { near } : {}), ...(language ? { lang: language } : {}) }, signal)
            const credits = readPlaceCredits(answer.credits)
            return {
                features: Array.isArray(answer.features) ? readPlaceFeatures(answer.features) : [],
                credits: credits.length > 0 ? credits : [OPENSTREETMAP_CREDIT],
            }
        } catch (error) {
            if (aborted(error)) throw error
            throw new Error(refusalMessage(error, host(server.origin)))
        }
    }

    return {
        availability() {
            if (options.photonUrl || options.server()) return { available: true }
            return {
                available: false,
                reason: options.offersSyncPlus ? `Searching by name comes with Sync+. ${INSTEAD}` : `Searching by name isn't set up here. ${INSTEAD}`,
            }
        },
        async search(query, near, signal) {
            const server = options.server()
            const found = options.photonUrl
                ? await viaPhoton(options.photonUrl, query, near, signal)
                : server
                  ? await viaServer(server, query, near, signal)
                  : { features: [], credits: [] }
            return { results: placeResults(found.features, query), credits: found.credits }
        },
    }
}
