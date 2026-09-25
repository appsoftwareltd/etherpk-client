/**
 * Application-facing sync messages derived from the shared wire contract. The `v` field is
 * added and checked only at the serialisation boundary so the document engine does not repeat
 * a transport constant on every operation.
 */
import {
    SYNC_PROTOCOL_VERSION,
    parseServerMessage as parseWireServerMessage,
    serializeClientMessage as serializeWireClientMessage,
    type SyncClientMessage,
    type SyncServerMessage,
} from '@appsoftwareltd/etherpk-shared'

type WithoutVersion<T> = T extends { v: typeof SYNC_PROTOCOL_VERSION } ? Omit<T, 'v'> : never

export type RelayClientMessage = WithoutVersion<SyncClientMessage>
export type RelayServerMessage = WithoutVersion<SyncServerMessage>
export type RelayUpdate = Extract<RelayServerMessage, { type: 'catchup_batch' }>['updates'][number]

/**
 * A server message as the Client reads it. `protocol_mismatch` is a message in another numeric
 * protocol version: the relay answers a Client on the wrong version with an error in its OWN
 * version, so both directions of a mismatch arrive here as "their `v` is not mine".
 * Everything else the shared parser refuses (bad JSON, a missing or non-integer `v`, an
 * oversized or unknown message) is `malformed` and is dropped.
 */
export type ServerMessageRead =
    | { kind: 'message'; message: RelayServerMessage }
    | { kind: 'protocol_mismatch'; serverVersion: number }
    | { kind: 'malformed' }

export function readServerMessage(raw: string): ServerMessageRead {
    const result = parseWireServerMessage(raw)
    if (result.ok) {
        const { v: _version, ...message } = result.value
        return { kind: 'message', message: message as RelayServerMessage }
    }
    if (result.code === 'unsupported_version') {
        // The shared parser reports this code only after the text parsed as a JSON object,
        // so reading it again cannot throw.
        const { v } = JSON.parse(raw) as { v?: unknown }
        if (typeof v === 'number' && Number.isInteger(v)) return { kind: 'protocol_mismatch', serverVersion: v }
    }
    return { kind: 'malformed' }
}

/** Returns null for anything malformed, oversized or from an unsupported protocol version. */
export function parseServerMessage(raw: string): RelayServerMessage | null {
    const read = readServerMessage(raw)
    return read.kind === 'message' ? read.message : null
}

/**
 * The Sync Server speaks another sync protocol version, so nothing it sends can be read and
 * nothing this Client sends will be accepted. Retrying cannot fix it; one side has to be
 * upgraded. The message is for logs and the Headless Client; the browser maps the error to
 * its own copy in `sync-error-copy.ts`.
 */
export class SyncProtocolMismatchError extends Error {
    override readonly name = 'SyncProtocolMismatchError'

    constructor(
        readonly serverVersion: number,
        readonly clientVersion: number = SYNC_PROTOCOL_VERSION,
    ) {
        super(
            serverVersion < clientVersion
                ? `The Sync Server speaks sync protocol ${serverVersion} and this Client speaks ${clientVersion}: the server is older, and its operator needs to upgrade it.`
                : `The Sync Server speaks sync protocol ${serverVersion} and this Client speaks ${clientVersion}: this Client is older and needs upgrading.`,
        )
    }

    get serverIsOlder(): boolean {
        return this.serverVersion < this.clientVersion
    }
}

export function serializeClientMessage(message: RelayClientMessage): string {
    return serializeWireClientMessage({ v: SYNC_PROTOCOL_VERSION, ...message } as SyncClientMessage)
}
