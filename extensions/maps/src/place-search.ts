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
 * and map links keep working whatever the answer. A refusal from the plan or the server is
 * remembered for that server while the graph is open, so the box stops offering search there.
 *
 * Two more questions go the same way (amendment of 2026-10-10): the place nearest a point, whose
 * name is offered for a place set down by hand, and the full link a short map link leads to, which
 * only a Sync Server can open. Neither says anything when it cannot answer: the name is only ever
 * an offer, and a short link the server cannot open gets the Map Block's own note.
 *
 * All three can be switched off in the Maps extension's settings (`search-services`, on unless
 * the person turns it off), and then nothing is asked of any service: no search, no lookup, no
 * short link. A person's own Mapbox token is not one of them: setting it is asking for Mapbox.
 */
import {
    OPENSTREETMAP_CREDIT,
    photonLanguage,
    photonReverseUrl,
    PLACE_SEARCH_MAX_RESULTS,
    PLACE_SEARCH_REFUSAL,
    type PlaceSearchCredit,
    type PlaceSearchFeature,
    readPlaceCredits,
    readPlaceFeatures,
} from '@appsoftwareltd/etherpk-shared'

import type { MapPoint } from '$lib/document/map-text'
import { SyncApiError, type SyncApi } from '$lib/sync/sync-api'

import type { NearestPlace, PlaceSearch, PlaceSearchResult } from './map-block-services'
import { haversineMeters } from './map-geometry'

/** What a service answered: the places, and the credits it asks for. */
interface Found {
    features: PlaceSearchFeature[]
    credits: PlaceSearchCredit[]
}

/** What a person can always do instead of searching by name: a postcode where the deployment has the files. */
function instead(postcodes: boolean): string {
    return `Type ${postcodes ? 'a UK or US postcode, ' : ''}coordinates such as 50.7486, -4.0789, or a Plus Code, or paste a link from Google Maps, Apple Maps or OpenStreetMap.`
}

/** The nearest place gives its own name within this many metres; beyond it, its village or town's. */
export const NEAREST_NAME_METERS = 100

/** A Sync Server to search through. */
export interface PlaceSearchServer {
    /** The server's origin, which names it in what the person is told. */
    origin: string
    api: Pick<SyncApi, 'searchPlaces' | 'reversePlace' | 'openMapLink'>
}

export interface PlaceSearchOptions {
    /** The server to ask now: the open graph's own, or the device's main connection; null for none. */
    server(): PlaceSearchServer | null
    /** A Photon search API the deployment names, asked directly; null for none. */
    photonUrl: string | null
    /** Whether this deployment offers Managed Sync, so someone without a server is told of Sync+. */
    offersSyncPlus: boolean
    /** Whether this deployment has postcode files, so a postcode is offered as what to type instead. */
    postcodes: boolean
    /** Whether the person allows the search and link services, read at each question. Allowed when left out. */
    enabled?(): boolean
    /** Hear the person change `enabled`. Returns the way to stop. */
    subscribe?(listener: () => void): () => void
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

/** A place's house number and street, or '' where it has neither. */
function streetOf(p: PlaceSearchFeature['properties']): string {
    return [p.housenumber, p.street].filter(Boolean).join(' ')
}

/** Where a place is, in words, leaving out its name. */
function describe(parts: readonly (string | undefined)[], name: string): string {
    return [...new Set(parts)].filter((part) => part && part !== name).join(', ')
}

/** The places found, as the Map Block lists them. */
export function placeResults(features: readonly PlaceSearchFeature[], query: string): PlaceSearchResult[] {
    const results = features.map((feature): PlaceSearchResult => {
        const p = feature.properties
        const [lon, lat] = feature.geometry.coordinates
        const street = streetOf(p)
        const name = p.name ?? (street || p.postcode || p.city || p.district || p.county || p.state || p.country || 'Unnamed place')
        // The county only where there is no town to name: "Brookmouth, Westshire", not "London, Greater London".
        const detail = describe([street, p.district, p.city ?? p.county, p.postcode, p.state, p.country], name)
        return { name, detail, point: { lat, lon }, postcode: p.postcode }
    })
    const postcode = ukPostcode(query)
    if (!postcode) return results
    return results.filter((result) => result.postcode !== undefined && ukPostcode(result.postcode) === postcode)
}

/**
 * The name to offer for a place set down at `point`, from the place nearest it: that place's own
 * name, or its address, when it is within `NEAREST_NAME_METERS`, and otherwise the village or town
 * it is in, since a farther place is not the one the person meant. A far place's address is left
 * out of the detail for the same reason.
 */
export function nearestPlaceName(feature: PlaceSearchFeature, point: MapPoint): { name: string; detail: string } {
    const p = feature.properties
    const [lon, lat] = feature.geometry.coordinates
    const town = p.city ?? p.district ?? ''
    if (haversineMeters(point, { lat, lon }) <= NEAREST_NAME_METERS) {
        const street = streetOf(p)
        const name = p.name ?? (street || town)
        return { name, detail: describe([street, p.district, p.city ?? p.county, p.postcode, p.state, p.country], name) }
    }
    return { name: town, detail: town ? describe([p.city ? p.district : undefined, p.county, p.state, p.country], town) : '' }
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

/** Why a server will not search for this person, which holds until the graph is closed, or null. */
function lastingRefusal(error: unknown, server: string, postcodes: boolean): string | null {
    if (!(error instanceof SyncApiError)) return null
    if (error.code === PLACE_SEARCH_REFUSAL.plan) return `Searching by place name needs Sync+. ${instead(postcodes)}`
    if (error.code === PLACE_SEARCH_REFUSAL.off) return `${server} doesn't search for places by name. ${instead(postcodes)}`
    return null
}

/** What a server's refusal tells the person to do. */
function refusalMessage(error: unknown, server: string, postcodes: boolean): string {
    const lasting = lastingRefusal(error, server, postcodes)
    if (lasting) return lasting
    if (error instanceof SyncApiError) {
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
    /** Each server's lasting refusal, by origin, so the box stops offering search there. */
    const refusedBy = new Map<string, string>()

    function remember(error: unknown, server: PlaceSearchServer): void {
        const lasting = lastingRefusal(error, host(server.origin), options.postcodes)
        if (lasting) refusedBy.set(server.origin, lasting)
    }

    async function askPhoton(asked: URL, signal: AbortSignal): Promise<Found> {
        const language = photonLanguage(lang())
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

    function viaPhoton(url: string, query: string, near: MapPoint | null, signal: AbortSignal): Promise<Found> {
        const asked = new URL(url)
        asked.searchParams.set('q', query)
        asked.searchParams.set('limit', String(PLACE_SEARCH_MAX_RESULTS))
        if (near) {
            asked.searchParams.set('lat', String(near.lat))
            asked.searchParams.set('lon', String(near.lon))
        }
        return askPhoton(asked, signal)
    }

    /** What a server answered, read as places, crediting OpenStreetMap where it names no credits. */
    function readAnswer(answer: { features?: unknown; credits?: unknown }): Found {
        const credits = readPlaceCredits(answer.credits)
        return {
            features: Array.isArray(answer.features) ? readPlaceFeatures(answer.features) : [],
            credits: credits.length > 0 ? credits : [OPENSTREETMAP_CREDIT],
        }
    }

    async function viaServer(server: PlaceSearchServer, query: string, near: MapPoint | null, signal: AbortSignal): Promise<Found> {
        try {
            const language = lang()
            return readAnswer(await server.api.searchPlaces({ q: query, ...(near ? { near } : {}), ...(language ? { lang: language } : {}) }, signal))
        } catch (error) {
            if (aborted(error)) throw error
            remember(error, server)
            throw new Error(refusalMessage(error, host(server.origin), options.postcodes))
        }
    }

    const switchedOff = () => options.enabled?.() === false
    const switchedOffReason = () => `Searching by place name is switched off in the Maps extension's settings. ${instead(options.postcodes)}`

    return {
        switchedOff,
        subscribe: (listener) => options.subscribe?.(listener) ?? (() => {}),
        availability() {
            if (switchedOff()) return { available: false, reason: switchedOffReason() }
            if (options.photonUrl) return { available: true }
            const server = options.server()
            if (server) {
                const refused = refusedBy.get(server.origin)
                return refused ? { available: false, reason: refused } : { available: true }
            }
            return {
                available: false,
                reason: options.offersSyncPlus
                    ? `Searching by place name needs Sync+. ${instead(options.postcodes)}`
                    : `Searching by place name isn't set up here. ${instead(options.postcodes)}`,
            }
        },
        async reverse(point, signal): Promise<NearestPlace | null> {
            if (switchedOff()) return null
            let found: Found
            if (options.photonUrl) {
                const asked = new URL(photonReverseUrl(options.photonUrl))
                asked.searchParams.set('lat', String(point.lat))
                asked.searchParams.set('lon', String(point.lon))
                asked.searchParams.set('limit', '1')
                try {
                    found = await askPhoton(asked, signal)
                } catch (error) {
                    if (aborted(error)) throw error
                    return null
                }
            } else {
                const server = options.server()
                if (!server || refusedBy.has(server.origin)) return null
                try {
                    const language = lang()
                    found = readAnswer(await server.api.reversePlace({ point, ...(language ? { lang: language } : {}) }, signal))
                } catch (error) {
                    if (aborted(error)) throw error
                    remember(error, server)
                    return null
                }
            }
            const [nearest] = found.features
            if (!nearest) return null
            const named = nearestPlaceName(nearest, point)
            return named.name ? { ...named, credits: found.credits } : null
        },
        async openShortLink(url, signal) {
            const server = options.server()
            if (!server || switchedOff()) return null
            try {
                const answer = await server.api.openMapLink({ url }, signal)
                return typeof answer?.url === 'string' ? answer.url : null
            } catch (error) {
                if (aborted(error)) throw error
                return null
            }
        },
        async search(query, near, signal) {
            if (switchedOff()) throw new Error(switchedOffReason())
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
