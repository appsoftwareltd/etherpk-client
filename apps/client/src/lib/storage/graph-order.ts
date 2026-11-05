/**
 * Graph Order: the sequence a person chooses for the graphs in one group of the Graphs page. Each
 * group has its own: the graphs on one Sync Server, or the Local Graphs on this device.
 *
 * What is saved is a list of graph ids, so it never has to match what a device holds. A device
 * passes over an id it does not hold, a graph it holds with no place goes after the ones that have
 * one, and a graph added to the device later drops into the place saved for it.
 *
 * A server group's order is one of the person's settings (ADR 0134), so it follows them to their
 * other devices and the later change wins. A graph id says nothing about the graph's content, and
 * the Settings Vault seals it anyway. Local order stays in this browser, like the folders it
 * lists: a person's settings leave the device when their account ends here, and that must not
 * disturb graphs that belong to no account.
 */
import type { PersonSettings } from '#lib/person-settings/person-settings.js'
import type { GraphRecord } from './graph-registry'

const LOCAL_ORDER_KEY = 'etherpk:local-graph-order'
const SERVER_ORDER_PREFIX = 'graph-order.'

/** `items` in the saved sequence, with anything the sequence does not name after, as it came. */
export function applyGraphOrder<T>(items: readonly T[], order: readonly string[], idOf: (item: T) => string): T[] {
    const place = new Map(order.map((id, index) => [id, index]))
    const placeOf = (item: T) => place.get(idOf(item)) ?? Number.POSITIVE_INFINITY
    // A stable sort, so the items with no place keep the order they came in.
    return [...items].sort((a, b) => {
        const [left, right] = [placeOf(a), placeOf(b)]
        return left === right ? 0 : left - right
    })
}

/**
 * The saved list once `shown` is the sequence on screen. The shown ids take over the places shown
 * ids held, so an id the list could not show (a graph on the server, seen from a device that is
 * offline) stays where it was rather than losing its place to a drag that never saw it.
 */
export function mergeGraphOrder(saved: readonly string[], shown: readonly string[]): string[] {
    const showing = new Set(shown)
    const places = [...saved, ...shown.filter((id) => !saved.includes(id))]
    let next = 0
    return places.map((id) => (showing.has(id) ? shown[next++] : id))
}

/** One group of graphs: those on the server at `origin`, or the Local Graphs when it is null. */
export interface GraphGroup {
    origin: string | null
    graphs: GraphRecord[]
}

export interface GraphGroupOptions {
    /** The servers in the sequence their groups show. */
    origins: readonly string[]
    isDemo: (graphId: string) => boolean
    orderOf: (origin: string | null) => readonly string[]
}

const recordId = (graph: GraphRecord) => graph.id

/**
 * Graphs in the groups they show in: synced groups first, then Local Graphs with the demo last,
 * each group in its Graph Order. A group with no graphs is left out.
 */
export function groupGraphs(graphs: readonly GraphRecord[], options: GraphGroupOptions): GraphGroup[] {
    const synced = graphs.filter((graph) => graph.backend === 'server')
    const originOf = (graph: GraphRecord) => graph.serverScope?.serverOrigin ?? ''
    // A record scoped to a server the sequence does not name still has to be listed somewhere.
    const origins = [...new Set([...options.origins, ...synced.map(originOf)])]
    const groups: GraphGroup[] = origins.map((origin) => ({
        origin,
        graphs: applyGraphOrder(
            synced.filter((graph) => originOf(graph) === origin),
            options.orderOf(origin),
            recordId,
        ),
    }))
    const local = graphs.filter((graph) => graph.backend !== 'server')
    const ordinary = local.filter((graph) => !options.isDemo(graph.id))
    const demo = local.filter((graph) => options.isDemo(graph.id))
    groups.push({ origin: null, graphs: [...applyGraphOrder(ordinary, options.orderOf(null), recordId), ...demo] })
    return groups.filter((group) => group.graphs.length > 0)
}

/** A saved order as a list of ids; anything else reads as none, so damage costs only the order. */
function parseOrder(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
        return []
    }
}

export interface GraphOrderStore {
    /** The saved order of the group on `origin`, or of Local Graphs when it is null. */
    read(origin: string | null): string[]
    /** Save `shown` as the group's sequence, keeping the places of the ids it does not name. */
    write(origin: string | null, shown: readonly string[]): void
    /** Called whenever an order changes: here, in another tab or from the account. */
    subscribe(listener: () => void): () => void
    /** Another tab wrote to storage: tell the listeners when the key is the local order. */
    storageChanged(key: string | null): void
}

/**
 * The orders of one device. Every read and write tolerates a storage that throws (a private
 * window, blocked site data), falling back to memory for the session.
 */
export function createGraphOrderStore(storage: () => Storage | null, person: PersonSettings): GraphOrderStore {
    const listeners = new Set<() => void>()
    let unsaved: string[] | null = null

    const serverKey = (origin: string) => `${SERVER_ORDER_PREFIX}${origin}`

    function readLocal(): string[] {
        if (unsaved) return unsaved
        try {
            return parseOrder(storage()?.getItem(LOCAL_ORDER_KEY))
        } catch {
            return []
        }
    }

    function writeLocal(order: string[]): void {
        try {
            storage()?.setItem(LOCAL_ORDER_KEY, JSON.stringify(order))
            unsaved = null
        } catch {
            unsaved = order
        }
    }

    const tell = () => {
        for (const listener of listeners) listener()
    }

    const store: GraphOrderStore = {
        read(origin) {
            return origin === null ? readLocal() : parseOrder(person.get(serverKey(origin)))
        },
        write(origin, shown) {
            const order = mergeGraphOrder(store.read(origin), shown)
            if (origin !== null) {
                // The person's settings tell the listeners themselves, through `person.subscribe`.
                person.set(serverKey(origin), JSON.stringify(order))
                return
            }
            writeLocal(order)
            tell()
        },
        subscribe(listener) {
            listeners.add(listener)
            const stopPerson = person.subscribe(listener)
            return () => {
                listeners.delete(listener)
                stopPerson()
            }
        },
        storageChanged(key) {
            if (key === null || key === LOCAL_ORDER_KEY) tell()
        },
    }
    return store
}
