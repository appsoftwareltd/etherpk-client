import { z } from 'zod'

/**
 * Searching for a place by name, address or postcode (ADR 0119): what a Client sends a Sync
 * Server's `POST /api/v1/sync/maps/search`, and what it answers.
 *
 * The answer is in Photon's form (GeoJSON features with OpenStreetMap address fields), whichever
 * service the Sync Server asks behind it, so a deployment can change that service without a Client
 * release, and a Client can also ask a Photon server directly. Only the fields a Client shows are
 * kept: a provider's own extras are stripped when the answer is parsed.
 *
 * The query travels in the request body, never in the address, so no request log holds it.
 *
 * An answer carries the credits its service asks for (`credits`), which a Client shows under the
 * places found: OpenStreetMap's for every service built on its data, and Geoapify's own, which its
 * Free plan requires. An answer from a server before credits carries none, and a Client then shows
 * OpenStreetMap's.
 */

/** The most characters a search may hold: an address with its town and country fits easily. */
export const PLACE_SEARCH_MAX_QUERY = 200

/** The most places one answer holds. */
export const PLACE_SEARCH_MAX_RESULTS = 8

/** The most credits one answer carries. */
export const PLACE_SEARCH_MAX_CREDITS = 4

/** A credit a search service asks for beside its answers: its words, and the page they link to. */
export interface PlaceSearchCredit {
    text: string
    url: string
}

/** OpenStreetMap's credit, which every answer built on its data carries. */
export const OPENSTREETMAP_CREDIT: PlaceSearchCredit = { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }

/** Geoapify's credit, which its Free plan requires beside its answers. */
export const GEOAPIFY_CREDIT: PlaceSearchCredit = { text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' }

/** Why a Sync Server would not search, as the `code` of its refusal. */
export const PLACE_SEARCH_REFUSAL = {
    /** The account's plan does not include searching. */
    plan: 'place_search_plan',
    /** The server has no search service. */
    off: 'place_search_off',
    /** The search service did not answer, or answered with something unreadable. */
    unavailable: 'place_search_unavailable',
} as const

const latitude = z.number().min(-90).max(90)
const longitude = z.number().min(-180).max(180)

export const placeSearchRequestSchema = z.strictObject({
    q: z.string().trim().min(1).max(PLACE_SEARCH_MAX_QUERY),
    /** Where the map is looking, so the nearest places come first. */
    near: z.strictObject({ lat: latitude, lon: longitude }).optional(),
    /** The reader's language, two letters, for the names of places. */
    lang: z
        .string()
        .regex(/^[a-z]{2}$/)
        .optional(),
})

export type PlaceSearchRequest = z.infer<typeof placeSearchRequestSchema>

/** A place's address fields, as Photon names them. Anything else a service sends is dropped. */
const placeProperties = z.object({
    name: z.string().optional(),
    housenumber: z.string().optional(),
    street: z.string().optional(),
    postcode: z.string().optional(),
    district: z.string().optional(),
    city: z.string().optional(),
    county: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    countrycode: z.string().optional(),
    /** What sort of place it is: a house, a street, a city, a postcode. */
    type: z.string().optional(),
})

export const placeSearchFeatureSchema = z.object({
    type: z.literal('Feature'),
    geometry: z.object({
        type: z.literal('Point'),
        // GeoJSON order: longitude first.
        coordinates: z.tuple([longitude, latitude]),
    }),
    properties: placeProperties,
})

const placeSearchCreditSchema = z.object({
    text: z.string().trim().min(1).max(100),
    // A link a Client puts on the page: never anything but https.
    url: z.url({ protocol: /^https$/ }),
})

export const placeSearchResponseSchema = z.object({
    type: z.literal('FeatureCollection'),
    features: z.array(placeSearchFeatureSchema).max(PLACE_SEARCH_MAX_RESULTS),
    credits: z.array(placeSearchCreditSchema).max(PLACE_SEARCH_MAX_CREDITS).optional(),
})

export type PlaceSearchFeature = z.infer<typeof placeSearchFeatureSchema>
export type PlaceSearchResponse = z.infer<typeof placeSearchResponseSchema>

/**
 * Keep the credits of an answer that read as credits, with https links, at most the answer's limit.
 * Anything else is dropped on its own, so a credit a Client cannot show safely never reaches it.
 */
export function readPlaceCredits(value: unknown): PlaceSearchCredit[] {
    if (!Array.isArray(value)) return []
    const kept: PlaceSearchCredit[] = []
    for (const credit of value) {
        const read = placeSearchCreditSchema.safeParse(credit)
        if (read.success) kept.push(read.data)
        if (kept.length === PLACE_SEARCH_MAX_CREDITS) break
    }
    return kept
}

/**
 * Keep the features of a service's answer that read as places, at most the answer's limit. A
 * feature whose fields do not read (no point, a latitude off the globe) is dropped on its own
 * rather than failing the whole answer.
 */
export function readPlaceFeatures(features: readonly unknown[]): PlaceSearchFeature[] {
    const kept: PlaceSearchFeature[] = []
    for (const feature of features) {
        const read = placeSearchFeatureSchema.safeParse(feature)
        if (read.success) kept.push(read.data)
        if (kept.length === PLACE_SEARCH_MAX_RESULTS) break
    }
    return kept
}
