/**
 * Whether this process's copy of a synced graph is following the Sync Server, and since when.
 *
 * The tools answer from a local copy, which keeps working when the relay cannot be reached. A
 * document's catch-up stays complete until a new socket starts the next one, so a read during an
 * outage returns old text with nothing in it to say so. This module says so: to the agent in a
 * note on every answer and in `graph_info`, and to a person in the host's log.
 *
 * It follows the socket. A link that dies without closing the socket reads as connected until the
 * operating system gives up on it, because the relay's keepalive runs from the server's side only.
 */

import type { SyncActivity } from '#lib/sync/graph-sync.js'

export type GraphConnection =
    | { state: 'connected'; since: string }
    /** `unsentDocuments` counts the documents holding edits the Sync Server has not acknowledged. */
    | { state: 'offline'; since: string; unsentDocuments: number }

export type OfflineConnection = Extract<GraphConnection, { state: 'offline' }>

export interface ConnectionChange {
    connection: GraphConnection
    /** How long the copy was offline, when a connection it had before has returned; otherwise null. */
    offlineForMs: number | null
}

/** The part of a graph's sync session this reads. */
export interface ConnectionSource {
    activity(): SyncActivity
    onActivity(listener: (activity: SyncActivity) => void): () => void
}

export interface FollowOptions {
    now?: () => number
    /** Called once for each change, whether a listener or a question noticed it first. */
    onChange?: (change: ConnectionChange) => void
}

/**
 * Follow `source` for as long as it lives; a session clears its listeners when disposed. Only an
 * open socket counts as connected, so `connecting`, `reconnecting` and `ended` are all offline: in
 * each of them the copy has stopped following the Sync Server.
 */
export function followConnection(source: ConnectionSource, options: FollowOptions = {}): { current(): GraphConnection } {
    const now = options.now ?? Date.now
    let connected = source.activity().connection === 'open'
    let everConnected = connected
    let since = now()

    const describe = (activity: SyncActivity): GraphConnection => {
        const at = new Date(since).toISOString()
        return connected ? { state: 'connected', since: at } : { state: 'offline', since: at, unsentDocuments: activity.unsentDocuments }
    }

    function observe(activity: SyncActivity): GraphConnection {
        const connectedNow = activity.connection === 'open'
        if (connectedNow !== connected) {
            const at = now()
            const offlineForMs = connectedNow && everConnected ? at - since : null
            connected = connectedNow
            everConnected ||= connectedNow
            since = at
            options.onChange?.({ connection: describe(activity), offlineForMs })
        }
        return describe(activity)
    }

    source.onActivity(observe)
    // A question reads the session itself, because its announcements arrive late (they coalesce).
    return { current: () => observe(source.activity()) }
}

function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? '' : 's'}`
}

function durationWords(ms: number): string {
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 60) return plural(minutes, 'minute')
    const hours = Math.floor(minutes / 60)
    return hours < 48 ? plural(hours, 'hour') : plural(Math.floor(hours / 24), 'day')
}

/** How the tools word the state, with the exact time and, in brackets, how long that is. */
export function offlineSince(connection: OfflineConnection, now = Date.now()): string {
    return `offline from the Sync Server since ${connection.since} (${durationWords(now - Date.parse(connection.since))})`
}

/** The note an answer carries while its copy is offline; null while connected and on a folder, which has no connection. */
export function offlineNotice(connection: GraphConnection | null, now = Date.now()): string | null {
    if (connection?.state !== 'offline') return null
    return `This computer's copy of the graph has been ${offlineSince(connection, now)}. This answer comes from that copy: it can lack edits made elsewhere since then, and a page or task it does not find may only be newer than the copy. Tell the user before relying on it. The copy catches up when the connection returns.`
}

/** One line for the host's log. */
export function connectionChangeLine(change: ConnectionChange): string {
    if (change.connection.state === 'offline') return "lost the connection to the Sync Server; the tools answer from this computer's copy."
    return change.offlineForMs === null ? 'connected to the Sync Server.' : `connected to the Sync Server again, after ${durationWords(change.offlineForMs)} offline.`
}
