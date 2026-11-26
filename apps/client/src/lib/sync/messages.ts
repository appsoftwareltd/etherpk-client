/**
 * Application-facing sync messages derived from the shared wire contract. The `v` field is
 * added and checked only at the serialisation boundary so the document engine does not repeat
 * a transport constant on every operation.
 */
import {
    SYNC_PROTOCOL_RANGE,
    SYNC_PROTOCOL_VERSION,
    createSyncProtocol,
    readSyncVersionRange,
    type SyncClientMessage,
    type SyncProtocol,
    type SyncServerMessage,
    type SyncVersionRange,
} from '@appsoftwareltd/etherpk-shared'

type WithoutVersion<T> = T extends { v: number } ? Omit<T, 'v'> : never

export type RelayClientMessage = WithoutVersion<SyncClientMessage>
export type RelayServerMessage = WithoutVersion<SyncServerMessage>
export type RelayUpdate = Extract<RelayServerMessage, { type: 'catchup_batch' }>['updates'][number]

/** This build's protocol. A test passes one of its own, with other versions. */
export const syncProtocol: SyncProtocol = createSyncProtocol()

/**
 * A server message as the Client reads it.
 * - `version_refused`: the two speak other versions. A relay answers a version it does not speak with
 *   an error in its own newest one and, to a Client that declares itself, the range it speaks; one
 *   released before the range (0.51.0) speaks only the version it answers in.
 * - `unknown`: a kind of message this build does not know, from a newer server. Passed over.
 * - `malformed`: everything else the shared parser refuses (bad JSON, a missing or non-integer `v`,
 *   an oversized or wrong message). Dropped.
 */
export type ServerMessageRead =
    | { kind: 'message'; message: RelayServerMessage }
    | { kind: 'version_refused'; serverRange: SyncVersionRange }
    | { kind: 'unknown' }
    | { kind: 'malformed' }

export function readServerMessage(raw: string, protocol: SyncProtocol = syncProtocol): ServerMessageRead {
    const result = protocol.parseServerMessage(raw)
    if (result.ok) {
        const { v, ...message } = result.value
        if (message.type === 'error' && message.code === 'unsupported_version') {
            return { kind: 'version_refused', serverRange: message.supported ?? { min: v, max: v } }
        }
        return { kind: 'message', message: message as RelayServerMessage }
    }
    if (result.code === 'unknown_type') return { kind: 'unknown' }
    if (result.code === 'unsupported_version') {
        // The shared parser reports this code only after the text parsed as a JSON object,
        // so reading it again cannot throw.
        const { v, supported } = JSON.parse(raw) as { v?: unknown; supported?: unknown }
        const only = readSyncVersionRange({ min: v, max: v })
        if (only) return { kind: 'version_refused', serverRange: readSyncVersionRange(supported) ?? only }
    }
    return { kind: 'malformed' }
}

/** Returns null for anything malformed, oversized, unknown or from an unsupported protocol version. */
export function parseServerMessage(raw: string): RelayServerMessage | null {
    const read = readServerMessage(raw)
    return read.kind === 'message' ? read.message : null
}

const rangeOf = (versions: number | SyncVersionRange): SyncVersionRange =>
    typeof versions === 'number' ? { min: versions, max: versions } : versions

const rangeText = ({ min, max }: SyncVersionRange) => (min === max ? String(max) : `${min} to ${max}`)

/**
 * The Sync Server and this Client have no protocol version in common, so nothing either sends can be
 * read by the other. Retrying cannot fix it; one side has to be upgraded, and `serverIsOlder` says
 * which. Edits stay in this device's outbox until then. The message is for logs and the Headless
 * Client; the browser and the installed apps map the error to their own copy in `sync-error-copy.ts`.
 */
export class SyncProtocolMismatchError extends Error {
    override readonly name = 'SyncProtocolMismatchError'
    readonly serverRange: SyncVersionRange
    readonly clientRange: SyncVersionRange

    constructor(server: number | SyncVersionRange, client: number | SyncVersionRange = SYNC_PROTOCOL_RANGE) {
        const serverRange = rangeOf(server)
        const clientRange = rangeOf(client)
        const older = serverRange.max < clientRange.min
        super(
            older
                ? `The Sync Server speaks sync protocol ${rangeText(serverRange)} and this Client speaks ${rangeText(clientRange)}: the server is older, and its operator needs to upgrade it.`
                : `The Sync Server speaks sync protocol ${rangeText(serverRange)} and this Client speaks ${rangeText(clientRange)}: this Client is older and needs upgrading.`,
        )
        this.serverRange = serverRange
        this.clientRange = clientRange
    }

    /** The server's newest version, and this Client's. */
    get serverVersion(): number {
        return this.serverRange.max
    }
    get clientVersion(): number {
        return this.clientRange.max
    }

    get serverIsOlder(): boolean {
        return this.serverRange.max < this.clientRange.min
    }
}

/** A message as `version` writes it. */
export function serializeClientMessage(
    message: RelayClientMessage,
    version: number = SYNC_PROTOCOL_VERSION,
    protocol: SyncProtocol = syncProtocol,
): string {
    return protocol.serializeClientMessage({ v: version, ...message } as SyncClientMessage)
}
