/**
 * Usage statistics transport (ADR 0187): where events go, and the queue that sends them in
 * batches. No browser APIs, so it is testable in Node.
 *
 * Events queue in memory, each with the time it happened. The queue is sent when the caller asks
 * (`tick`, every minute; `flush`, when the page is hidden) and when it holds {@link MAX_BATCH}
 * events. A name is queued at most {@link PER_NAME_CAP} times between two `tick`s, so a held key
 * cannot fill it. Nothing is written to the device, so events queued when a page crashes are lost.
 *
 * What an event may hold is `usage-catalogue.ts`, which every event is checked against. The event's
 * host and address are constants (`etherpk-client`, `/app`), so a self-hosted deployment's own
 * address is never sent. No identifier is made or kept: the collector, Umami, tells one browser
 * from another by a hash of the address and the browser, with a salt it changes over time.
 */

import { checkUsageEvent, type UsageEvent } from './usage-catalogue'

/** EtherPK's Umami server. A deployment that names it in `PUBLIC_TELEMETRY_URL` needs no website id. */
export const DEFAULT_TELEMETRY_URL = 'https://analytics.appsoftware.com'

/**
 * The website id EtherPK's Umami server files the Client's events under, used when a deployment
 * sets `PUBLIC_TELEMETRY_URL` to that server and no `PUBLIC_TELEMETRY_WEBSITE_ID`.
 */
export const BUILT_IN_TELEMETRY_WEBSITE_ID: string | null = '665df204-0128-46c0-8003-a7927afc2246'

export const MAX_BATCH = 50
export const PER_NAME_CAP = 20
/** How many sent events the Privacy tab can show. */
export const SENT_LOG_LIMIT = 200

const WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where batches are posted, and the website id they are filed under. */
export interface TelemetryTarget {
    /** Umami's batch endpoint. */
    url: string
    websiteId: string
}

/** `address/api/batch`, keeping a path the server is served under; null for an address that is not http(s). */
function batchEndpoint(address: string): string | null {
    try {
        const base = new URL(address.endsWith('/') ? address : `${address}/`)
        if (base.protocol !== 'https:' && base.protocol !== 'http:') return null
        return new URL('api/batch', base).href
    } catch {
        return null
    }
}

/**
 * The Umami server for this deployment, or null when it sends no usage statistics.
 *
 * Off unless the deployment sets `PUBLIC_TELEMETRY_URL` to an address. On EtherPK's server
 * (`DEFAULT_TELEMETRY_URL`) events are filed under the Client's built-in website id, except in
 * development; any other server needs `PUBLIC_TELEMETRY_WEBSITE_ID`, which also overrides the
 * built-in id. A setting that cannot be used turns usage statistics off rather than failing the
 * page.
 */
export function telemetryTarget(settings: TelemetrySettings): TelemetryTarget | null {
    const address = settings.url?.trim() ?? ''
    const url = address === '' ? null : batchEndpoint(address)
    if (url === null) return null
    const websiteId = websiteIdFor(url, settings)
    return websiteId === null ? null : { url, websiteId }
}

interface TelemetrySettings {
    url: string | undefined
    websiteId: string | undefined
    dev: boolean
    builtInWebsiteId?: string | null
}

/** The website id given, if it is one; else the built-in id, for EtherPK's server outside development. */
function websiteIdFor(url: string, settings: TelemetrySettings): string | null {
    const given = settings.websiteId?.trim() ?? ''
    if (given !== '') return WEBSITE_ID.test(given) ? given : null
    if (settings.dev || url !== batchEndpoint(DEFAULT_TELEMETRY_URL)) return null
    return settings.builtInWebsiteId === undefined ? BUILT_IN_TELEMETRY_WEBSITE_ID : settings.builtInWebsiteId
}

/** An event as it was queued and sent, for the Privacy tab's list. */
export interface SentEvent extends UsageEvent {
    /** Milliseconds since 1970. */
    at: number
}

export interface TelemetryDependencies {
    target: TelemetryTarget | null
    /** Asked when an event is queued and again when the queue is sent. */
    allowed: () => boolean
    /** Milliseconds since 1970. */
    now: () => number
    /** Post `body` to `url`. Its failure is nobody's concern. */
    send: (url: string, body: string) => void
}

export interface Telemetry {
    /** False when this deployment has no collector. */
    readonly available: boolean
    /** Queue an event. One the catalogue does not declare is dropped. */
    record(event: UsageEvent): void
    /** Send what is queued. */
    flush(): void
    /** Send what is queued and start a new window for {@link PER_NAME_CAP}. */
    tick(): void
    /** The events sent from this page, oldest first, the last {@link SENT_LOG_LIMIT}. */
    sent(): readonly SentEvent[]
    /** Called after each batch is sent. */
    subscribe(listener: () => void): () => void
}

export function createTelemetry(deps: TelemetryDependencies): Telemetry {
    const { target } = deps
    let queue: SentEvent[] = []
    let counts = new Map<string, number>()
    let log: SentEvent[] = []
    const listeners = new Set<() => void>()

    function post(to: TelemetryTarget, batch: SentEvent[]): void {
        const body = batch.map(({ name, data, at }) => ({
            type: 'event',
            payload: {
                website: to.websiteId,
                hostname: 'etherpk-client',
                url: '/app',
                name,
                // Umami takes the time in seconds; without it, it uses the time the batch arrived.
                timestamp: Math.floor(at / 1000),
                ...(data ? { data } : {}),
            },
        }))
        try {
            deps.send(to.url, JSON.stringify(body))
        } catch {
            // Dropped: the counts are lost and nothing else.
        }
    }

    function flush(): void {
        if (target === null || queue.length === 0) return
        const batch = queue
        queue = []
        // Turned off since these were queued: they are dropped, not sent.
        if (!deps.allowed()) return
        post(target, batch)
        log = [...log, ...batch].slice(-SENT_LOG_LIMIT)
        for (const listener of listeners) listener()
    }

    function record(event: UsageEvent): void {
        // Reporting is never a reason for the feature that reported to fail.
        try {
            if (target === null || !deps.allowed() || !checkUsageEvent(event)) return
            const count = (counts.get(event.name) ?? 0) + 1
            counts.set(event.name, count)
            if (count > PER_NAME_CAP) return
            queue.push({ ...event, at: deps.now() })
            if (queue.length >= MAX_BATCH) flush()
        } catch {
            // Dropped.
        }
    }

    return {
        available: target !== null,
        record,
        flush,
        tick() {
            flush()
            counts = new Map()
        },
        sent: () => log,
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}
