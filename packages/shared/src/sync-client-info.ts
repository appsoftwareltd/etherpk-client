import { UNDECLARED_SYNC_PROTOCOL_VERSION } from './sync-protocol'

/**
 * What a Client says of itself when it opens the sync socket: which kind of Client it is, its
 * release, and the protocol version it will speak. It is in the address because a browser can put it
 * nowhere else, and 0.51.0 servers ignore it there.
 *
 * It names the software and nobody: no device, no account, no operating system. A server uses it for
 * its log and to know what it may send, and never to decide what a person may do.
 */
export interface SyncClientInfo {
    kind: SyncClientKind
    /** The release, `major.minor.patch`. */
    version: string
}

/** In a browser, in an installed app, or the Headless Client. */
export type SyncClientKind = (typeof SYNC_CLIENT_KINDS)[number]
const SYNC_CLIENT_KINDS = ['web', 'installed', 'headless'] as const

const CLIENT = new RegExp(`^(${SYNC_CLIENT_KINDS.join('|')})/(\\d{1,4}\\.\\d{1,4}\\.\\d{1,4})$`)
const PROTOCOL_VERSION = /^[1-9]\d{0,5}$/

/** The address to open, with the token and what the Client says of itself. */
export function syncConnectUrl(
    relayUrl: string,
    token: string,
    protocolVersion: number,
    client: SyncClientInfo | null,
): string {
    const query = new URLSearchParams({ token, v: String(protocolVersion) })
    const named = client ? `${client.kind}/${client.version}` : ''
    if (CLIENT.test(named)) query.set('client', named)
    return `${relayUrl}?${query}`
}

/** What the socket's address says of the Client that opened it. */
export interface SyncConnect {
    /**
     * The Client named the version it speaks. Every release that does also leaves out fields it does
     * not know, so the server may send it one.
     */
    declared: boolean
    version: number
    client: SyncClientInfo | null
}

export function readSyncConnect(query: URLSearchParams): SyncConnect {
    const version = query.get('v') ?? ''
    if (!PROTOCOL_VERSION.test(version)) {
        return { declared: false, version: UNDECLARED_SYNC_PROTOCOL_VERSION, client: null }
    }
    const client = CLIENT.exec(query.get('client') ?? '')
    return {
        declared: true,
        version: Number(version),
        client: client ? { kind: client[1] as SyncClientKind, version: client[2] } : null,
    }
}
