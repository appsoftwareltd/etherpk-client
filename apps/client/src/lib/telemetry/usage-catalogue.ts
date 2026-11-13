/**
 * Every usage statistics event the Client can send (ADR 0187), and the only way to make one.
 *
 * Each entry declares a family of event names, when it is sent, and each property with the
 * values it may take. `checkUsageEvent` refuses anything the catalogue does not declare, and the
 * telemetry queue runs it on every event, so a change elsewhere cannot send a field or a value
 * this file does not name.
 *
 * Nothing here holds what a person wrote: an event name is built from a Command id, a View kind or
 * a Settings tab, all constants in code, and checked against a plain dotted shape. A value is one
 * of a fixed list, a release version, or a bucket.
 */

/**
 * A property: the values it may take, `version` for a release number, or `error-class` for an
 * error's class name (`TypeError`), checked by shape.
 */
type PropertyRule = readonly string[] | 'version' | 'error-class'

export interface CatalogueEntry {
    /** The name as a reader sees it, with a placeholder for the variable part. */
    label: string
    /** The names this entry covers. */
    pattern: RegExp
    /** When it is sent, in a sentence. */
    when: string
    properties: Record<string, { rule: PropertyRule; meaning: string }>
}

export const DURATION_BUCKETS = ['<1m', '1-5m', '5-15m', '15-60m', '60m+'] as const
export const OPEN_TIME_BUCKETS = ['<1s', '1-3s', '3-10s', '10s+'] as const
export const PAGE_COUNT_BUCKETS = ['0', '1-10', '11-100', '101-1000', '1000+'] as const
export const ASSET_TYPES = ['pdf', 'epub', 'image', 'video', 'audio', 'drawing', 'other'] as const
export const GRAPH_KINDS = ['synced', 'folder', 'browser'] as const

/** A plain dotted name: lower-case start, letters, digits and hyphens, at most four parts. */
const DOTTED = '[a-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*){0,3}'

export const USAGE_CATALOGUE: readonly CatalogueEntry[] = [
    {
        label: 'app_opened',
        pattern: /^app_opened$/,
        when: 'Each time the app starts.',
        properties: {
            version: { rule: 'version', meaning: "the app's version" },
            install: { rule: ['installed', 'browser'], meaning: 'installed app or browser tab' },
            deployment: { rule: ['managed', 'self-hosted'], meaning: "EtherPK's service or someone's own server" },
            layout: { rule: ['desktop', 'phone'], meaning: 'the desktop or the phone layout' },
            theme: { rule: ['light', 'dark'], meaning: 'the light or the dark theme' },
        },
    },
    {
        label: 'graph_opened',
        pattern: /^graph_opened$/,
        when: 'Each time a graph opens.',
        properties: {
            kind: { rule: GRAPH_KINDS, meaning: 'synced, a folder on the computer, or kept in the browser' },
            pages: { rule: PAGE_COUNT_BUCKETS, meaning: 'roughly how many pages it has' },
            openTime: { rule: OPEN_TIME_BUCKETS, meaning: 'roughly how long it took to open' },
        },
    },
    {
        label: 'command.<name>',
        pattern: new RegExp(`^command\\.${DOTTED}$`),
        when: 'Each time a command runs, by its name, such as command.tasks.open.',
        properties: {},
    },
    {
        label: 'view.<kind>',
        pattern: new RegExp(`^view\\.${DOTTED}$`),
        when: 'Each time a tab or panel opens, by its kind, such as view.tasks or view.document.',
        properties: {
            type: { rule: ASSET_TYPES, meaning: 'for a file, its type' },
        },
    },
    {
        label: 'settings.<tab>',
        pattern: /^settings\.[a-z]+$/,
        when: 'Each time a Settings tab is shown, such as settings.spelling.',
        properties: {},
    },
    {
        label: 'app_hidden',
        pattern: /^app_hidden$/,
        when: 'When you switch away from the app or close it.',
        properties: {
            visible: { rule: DURATION_BUCKETS, meaning: 'roughly how long it was on screen' },
        },
    },
    {
        label: 'error',
        pattern: /^error$/,
        when: 'When something in the app fails unexpectedly.',
        properties: {
            version: { rule: 'version', meaning: "the app's version" },
            kind: { rule: 'error-class', meaning: 'the kind of error, such as TypeError, never its message' },
        },
    },
]

/** An error class name, as `Error.name` gives it for the built-in and DOM errors. */
const ERROR_KINDS = /^(?:[A-Z][A-Za-z]{0,40}Error|Unknown)$/

/** One event as the queue holds it. */
export interface UsageEvent {
    name: string
    data?: Record<string, string>
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/
/** The collector's limit on an event name. */
const MAX_NAME = 50

function valueAllowed(rule: PropertyRule, value: string): boolean {
    if (rule === 'version') return VERSION.test(value)
    if (rule === 'error-class') return ERROR_KINDS.test(value)
    return rule.includes(value)
}

/** Whether the catalogue declares this event: its name, each property and each value. */
export function checkUsageEvent(event: UsageEvent): boolean {
    if (event.name.length > MAX_NAME) return false
    const entry = USAGE_CATALOGUE.find((candidate) => candidate.pattern.test(event.name))
    if (!entry) return false
    return Object.entries(event.data ?? {}).every(([key, value]) => {
        const property = entry.properties[key]
        return property !== undefined && valueAllowed(property.rule, value)
    })
}

/** Which bucket `value` falls in, given each bucket's upper bound (exclusive). */
function bucket<T extends string>(value: number, buckets: readonly T[], bounds: readonly number[]): T {
    const index = bounds.findIndex((bound) => value < bound)
    return buckets[index === -1 ? buckets.length - 1 : index]
}

export const durationBucket = (ms: number) => bucket(ms, DURATION_BUCKETS, [60_000, 300_000, 900_000, 3_600_000])
export const openTimeBucket = (ms: number) => bucket(ms, OPEN_TIME_BUCKETS, [1_000, 3_000, 10_000])
export const pageCountBucket = (count: number) => bucket(count, PAGE_COUNT_BUCKETS, [1, 11, 101, 1001])

const ASSET_TYPE_OF: Record<string, (typeof ASSET_TYPES)[number]> = {
    pdf: 'pdf',
    epub: 'epub',
    excalidraw: 'drawing',
    ...Object.fromEntries(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'].map((e) => [e, 'image' as const])),
    ...Object.fromEntries(['mp4', 'webm', 'mov', 'm4v', 'ogv'].map((e) => [e, 'video' as const])),
    ...Object.fromEntries(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'opus'].map((e) => [e, 'audio' as const])),
}

/** A file's type from its extension, from a fixed list: the file's name is never sent. */
export function assetType(extension: string): (typeof ASSET_TYPES)[number] {
    return ASSET_TYPE_OF[extension.toLowerCase()] ?? 'other'
}

/** The class of a thrown value, from a fixed shape, never its message. */
export function errorKind(thrown: unknown): string {
    const name = thrown instanceof Error || thrown instanceof DOMException ? thrown.name : ''
    return ERROR_KINDS.test(name) ? name : 'Unknown'
}
