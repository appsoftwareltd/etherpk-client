import { z } from 'zod'
import { quotaErrorCodeSchema } from './managed-service'

/**
 * 3 (ADR 0127): Graph Key epochs. Writes under an epoch older than the graph's current one are
 * refused with `stale_epoch`, the relay tells live members of a new epoch with `epoch_changed`,
 * and presence declares its epoch so stale presence can be dropped unread.
 */
export const SYNC_PROTOCOL_VERSION = 3

/**
 * The version of a peer that does not name one when it connects. Naming one came after version 3 and
 * every release before it speaks exactly 3, so this stays 3 whatever the current version becomes.
 */
export const UNDECLARED_SYNC_PROTOCOL_VERSION = 3

/** The versions a build speaks, both ends included. There are no gaps. */
export interface SyncVersionRange {
    min: number
    max: number
}

/** The newest version both sides speak, or null when they have none in common. */
export function newestCommonVersion(one: SyncVersionRange, other: SyncVersionRange): number | null {
    const newest = Math.min(one.max, other.max)
    return newest >= Math.max(one.min, other.min) ? newest : null
}

/** A range out of something a peer sent, or null when it is not one. */
export function readSyncVersionRange(value: unknown): SyncVersionRange | null {
    const read = versionRangeSchema.safeParse(value)
    return read.success ? read.data : null
}

const versionRangeSchema = z
    .object({ min: z.number().int().positive().safe(), max: z.number().int().positive().safe() })
    .refine(({ min, max }) => min <= max)

export interface SyncProtocolLimits {
    maxMessageBytes: number
    maxEnvelopeBytes: number
    maxSubscriptionDocIds: number
    maxCatchupRows: number
    maxCatchupBytes: number
    malformedMessageBudget: number
    /**
     * A presence envelope (one encrypted awareness update, a few hundred bytes in practice)
     * is bounded separately from content. The relay keeps the latest one per connection and
     * document and replays it to every late subscriber with no database work in the way, so
     * sharing the content ceiling would turn one upload into an outbound amplifier.
     */
    maxPresenceEnvelopeBytes: number
    /**
     * Document subscriptions one connection may hold at once. `maxSubscriptionDocIds` bounds a
     * single message; this bounds the cumulative set, which used to grow without limit.
     */
    maxSubscriptionsPerConnection: number
    /**
     * Outbound bytes the relay lets queue for one socket before it gives up on the reader.
     * The client resubscribes and catches up from durable storage on reconnect, so dropping a
     * reader that stops draining loses nothing except its live feed.
     */
    maxOutboundBufferedBytes: number
    /**
     * Sockets one user may hold open on one graph. Every browser tab holds its own socket, and
     * so does every Headless Client serving the graph to an agent, so the default leaves room
     * for a person who keeps many tabs open: an idle socket costs the relay a few kilobytes.
     * The socket over the limit is closed with {@link SOCKETS_LIMIT_CLOSE_CODE}.
     */
    maxSocketsPerUserGraph: number
}

export const SYNC_PROTOCOL_LIMITS: Readonly<SyncProtocolLimits> = Object.freeze({
    maxMessageBytes: 12 * 1024 * 1024,
    maxEnvelopeBytes: 8 * 1024 * 1024,
    maxSubscriptionDocIds: 512,
    maxCatchupRows: 256,
    maxCatchupBytes: 8 * 1024 * 1024,
    malformedMessageBudget: 3,
    maxPresenceEnvelopeBytes: 16 * 1024,
    maxSubscriptionsPerConnection: 4096,
    maxOutboundBufferedBytes: 64 * 1024 * 1024,
    maxSocketsPerUserGraph: 32,
})

export type SyncProtocolLimitOverrides = Partial<SyncProtocolLimits>

/**
 * The close code the relay gives a socket over `maxSocketsPerUserGraph`: 4000 plus the HTTP
 * status it mirrors, as 4401 and 4403 are. The socket has opened by then (a WebSocket cannot be
 * refused with a code any earlier), so a client reads it as "no place for this connection yet",
 * opens the graph from what the device holds, and asks again later.
 */
export const SOCKETS_LIMIT_CLOSE_CODE = 4429

/**
 * The close code for a Client that named a protocol version the server does not speak (4000 plus the
 * HTTP status 426). The `unsupported_version` error sent first says which versions it does.
 */
export const UNSUPPORTED_VERSION_CLOSE_CODE = 4426

export const SYNC_ERROR_CODES = [
    'unsupported_version',
    'invalid_message',
    'oversized_message',
    'stale_generation',
    'missing_sequence',
    'membership_revoked',
    'outbox_conflict',
    'quota_denied',
    /** A subscribe that would take the connection past `maxSubscriptionsPerConnection`; nothing was subscribed. */
    'subscription_limit',
    /** A snapshot read-back named a (generation, throughSeq) the relay does not hold. */
    'snapshot_missing',
    /**
     * A write sealed under a Graph Key epoch older than the graph's current one (ADR 0127). Nothing
     * was stored. The client collects its copy of the new keyring, seals the write again under the
     * current epoch, and sends it with a new outbox id.
     */
    'stale_epoch',
    'internal_error',
] as const

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]

/**
 * The code a message of kind `error` is read with when the sender's code is not one of the above: a
 * newer Sync Server refused something for a reason this build has no word for. The server never
 * sends it.
 */
export const UNKNOWN_SYNC_ERROR = 'unknown_error'

const knownErrorCodes: ReadonlySet<string> = new Set(SYNC_ERROR_CODES)

/** An error code as a Client reads it: a bounded string, known or not. */
const receivedErrorCode = z
    .string()
    .min(1)
    .max(64)
    .transform((code) => (knownErrorCodes.has(code) ? (code as SyncErrorCode) : UNKNOWN_SYNC_ERROR))

const safeInteger = z.number().int().nonnegative().safe()
const generation = z.number().int().positive().safe()
const uuid = z.uuid()
const base64Url = z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => value.length % 4 !== 1, 'Invalid unpadded base64url length')

/**
 * The presence envelope's tighter bound, restated in the schema so a message that somehow
 * reaches `safeParse` without the preflight is still refused. The preflight normally answers
 * first, with the more specific `oversized_message` code.
 */
function presenceEnvelopeSchema(limits: SyncProtocolLimits) {
    return base64Url.refine(
        (value) => (decodedBase64UrlBytes(value) ?? 0) <= limits.maxPresenceEnvelopeBytes,
        'Presence envelope exceeds the configured byte limit',
    )
}

/**
 * Both schemas are read tolerantly: a field they do not name is left out, so a peer one release ahead
 * may add one. That is only safe for a field whose absence means what it meant before. A change an
 * older reader must not miss raises the protocol version. Every field named here keeps its exact
 * shape and its limits, and a missing one is still an invalid message.
 *
 * `v` was matched to this wire version before the schema runs (see `parseMessage`).
 */
function clientMessageSchema(limits: SyncProtocolLimits) {
    const version = z.number()
    const presenceEnvelope = presenceEnvelopeSchema(limits)
    const subscribe = z.union([
        z.object({ v: version, type: z.literal('subscribe'), all: z.literal(true) }),
        z.object({
            v: version,
            type: z.literal('subscribe'),
            docIds: z.array(uuid).max(limits.maxSubscriptionDocIds),
        }),
    ])

    return z.discriminatedUnion('type', [
        // Zod cannot discriminate the two subscribe shapes itself, so validate their union
        // as one schema in a final outer union below.
        z.object({
            v: version,
            type: z.literal('unsubscribe'),
            docIds: z.array(uuid).max(limits.maxSubscriptionDocIds),
        }),
        z.object({
            v: version,
            type: z.literal('watermarks'),
            requestId: uuid,
            docIds: z.array(uuid).min(1).max(limits.maxSubscriptionDocIds),
        }),
        z.object({
            v: version,
            type: z.literal('append'),
            docId: uuid,
            outboxId: uuid,
            generation,
            epochId: safeInteger,
            envelope: base64Url,
        }),
        z.object({
            v: version,
            type: z.literal('delete'),
            docId: uuid,
            outboxId: uuid,
            generation,
        }),
        z.object({
            v: version,
            type: z.literal('resurrect'),
            docId: uuid,
            outboxId: uuid,
            generation,
            epochId: safeInteger,
            envelope: base64Url,
        }),
        z.object({
            v: version,
            type: z.literal('catchup'),
            requestId: uuid,
            docId: uuid,
            generation,
            afterSeq: safeInteger,
            priority: z.enum(['foreground', 'background']),
            maxRows: z.number().int().positive().max(limits.maxCatchupRows),
            maxBytes: z.number().int().positive().max(limits.maxCatchupBytes),
        }),
        z.object({
            v: version,
            type: z.literal('snapshot_put'),
            docId: uuid,
            generation,
            throughSeq: safeInteger,
            epochId: safeInteger,
            envelope: base64Url,
        }),
        // Read-back verification (ADR 0025, amended 2026-09-12): the compacting client asks
        // for the snapshot it just stored, decodes it, and only then declares it verified.
        // The relay prunes history only behind a verified snapshot.
        z.object({
            v: version,
            type: z.literal('snapshot_get'),
            docId: uuid,
            generation,
            throughSeq: safeInteger,
        }),
        z.object({
            v: version,
            type: z.literal('snapshot_verified'),
            docId: uuid,
            generation,
            throughSeq: safeInteger,
        }),
        // The epoch the presence envelope is sealed under, so the relay drops presence under an
        // older epoch without reading the envelope (ADR 0127).
        z.object({ v: version, type: z.literal('presence'), docId: uuid, epochId: safeInteger, envelope: presenceEnvelope }),
        z.object({ v: version, type: z.literal('ack_confirm'), outboxId: uuid }),
    ]).or(subscribe)
}

function serverMessageSchema(limits: SyncProtocolLimits) {
    const version = z.number()
    const presenceEnvelope = presenceEnvelopeSchema(limits)
    const update = z.object({
        seq: safeInteger,
        epochId: safeInteger,
        envelope: base64Url,
    })
    const snapshot = z.object({
        throughSeq: safeInteger,
        epochId: safeInteger,
        envelope: base64Url,
    })

    return z.discriminatedUnion('type', [
        z.object({
            v: version,
            type: z.literal('ack'),
            outboxId: uuid,
            generation,
            state: z.enum(['active', 'deleted']),
            seq: safeInteger,
        }),
        z.object({ v: version, type: z.literal('update'), docId: uuid, generation }).extend(update.shape),
        /** The relay stored a snapshot_put; the client may now read it back. */
        z.object({
            v: version,
            type: z.literal('snapshot_ack'),
            docId: uuid,
            generation,
            throughSeq: safeInteger,
        }),
        /** The stored snapshot, served back by exact identity for verification. */
        z.object({
            v: version,
            type: z.literal('snapshot_data'),
            docId: uuid,
            generation,
            throughSeq: safeInteger,
            epochId: safeInteger,
            envelope: base64Url,
        }),
        z.object({
            v: version,
            type: z.literal('catchup_batch'),
            /** Omitted only for unsolicited delete lifecycle broadcasts. */
            requestId: uuid.optional(),
            docId: uuid,
            generation,
            state: z.enum(['active', 'deleted']),
            throughSeq: safeInteger,
            hasMore: z.boolean(),
            updates: z.array(update).max(limits.maxCatchupRows),
            snapshot: snapshot.optional(),
        }),
        z.object({ v: version, type: z.literal('presence'), docId: uuid, envelope: presenceEnvelope }),
        /**
         * The graph's Graph Key moved to a new epoch (ADR 0127), or, sent once on connect, the epoch
         * a graph past its first is on. The client collects its copy of the keyring when it lacks
         * that epoch and seals what it writes from now on under it; older writes are refused.
         */
        z.object({ v: version, type: z.literal('epoch_changed'), epoch: generation }),
        z.object({
            v: version,
            type: z.literal('watermarks'),
            requestId: uuid,
            documents: z
                .array(z.object({ docId: uuid, generation, state: z.enum(['active', 'deleted']), lastSeq: safeInteger }))
                .max(limits.maxSubscriptionDocIds),
        }),
        z.object({
            v: version,
            type: z.literal('error'),
            code: receivedErrorCode,
            message: z.string().min(1).max(256),
            docId: uuid.optional(),
            /**
             * The outbox operation a `quota_denied` refused (append, delete or resurrect), so
             * the client retries that operation rather than waiting for an ack that never comes.
             * Absent for a refused snapshot, which is not an outbox operation.
             */
            outboxId: uuid.optional(),
            currentGeneration: generation.optional(),
            /** With `stale_epoch`: the graph's current epoch, which the write must be sealed under. */
            currentEpoch: generation.optional(),
            // One this build does not know is left out, and the refusal kept.
            quotaCode: quotaErrorCodeSchema.optional().catch(undefined),
            retryable: z.boolean().optional(),
            /**
             * With `unsupported_version`: the versions the server speaks. Sent only to a Client
             * that declared itself (sync-client-info.ts): 0.51.0 refuses a field it does not know.
             */
            supported: versionRangeSchema.optional().catch(undefined),
        }),
    ])
}

// Exported because the types below are derived from them with `typeof`, and a module-private
// binding used only in type position reads as dead code to every tool that looks.
export const defaultClientMessageSchema = clientMessageSchema(SYNC_PROTOCOL_LIMITS)
export const defaultServerMessageSchema = serverMessageSchema(SYNC_PROTOCOL_LIMITS)

/** The exact JSON message accepted from a sync client. */
export type SyncClientMessage = z.infer<typeof defaultClientMessageSchema>
/** The exact JSON message accepted from a sync server. */
export type SyncServerMessage = z.infer<typeof defaultServerMessageSchema>
export type SyncUpdate = Extract<SyncServerMessage, { type: 'catchup_batch' }>['updates'][number]

export type SyncProtocolParseResult<T> =
    | { ok: true; value: T }
    /** `unknown_type` is a well-formed message of a kind this build has no reader for: a newer peer's. */
    | { ok: false; code: 'unsupported_version' | 'invalid_message' | 'oversized_message' | 'unknown_type'; message: string }

function byteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength
}

/** Exact decoded size for valid, unpadded base64url without allocating decoded bytes. */
export function decodedBase64UrlBytes(value: string): number | null {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null
    return Math.floor((value.length * 3) / 4)
}

export function validateBase64UrlEnvelope(
    value: unknown,
    limits: Pick<SyncProtocolLimits, 'maxEnvelopeBytes'> = SYNC_PROTOCOL_LIMITS,
): SyncProtocolParseResult<string> {
    if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, code: 'invalid_message', message: 'Envelope is not valid base64url' }
    }
    const bytes = decodedBase64UrlBytes(value)
    if (bytes === null) return { ok: false, code: 'invalid_message', message: 'Envelope is not valid base64url' }
    if (bytes > limits.maxEnvelopeBytes) {
        return { ok: false, code: 'oversized_message', message: 'Envelope exceeds the configured byte limit' }
    }
    return { ok: true, value }
}

function envelopePreflight(
    parsed: SyncMessageRecord,
    limits: SyncProtocolLimits,
): SyncProtocolParseResult<true> {
    const envelopes: unknown[] = []
    if ('envelope' in parsed) envelopes.push(parsed.envelope)
    if (parsed.type === 'catchup_batch') {
        if (Array.isArray(parsed.updates)) {
            for (const update of parsed.updates) {
                if (typeof update === 'object' && update !== null) {
                    envelopes.push((update as Record<string, unknown>).envelope)
                }
            }
        }
        if (typeof parsed.snapshot === 'object' && parsed.snapshot !== null) {
            envelopes.push((parsed.snapshot as Record<string, unknown>).envelope)
        }
    }

    // Presence is bounded on its own, in both directions: the relay parses it inbound and the
    // client parses the relay's broadcast and late-join replay of the very same envelope.
    const envelopeLimit =
        parsed.type === 'presence' ? { maxEnvelopeBytes: limits.maxPresenceEnvelopeBytes } : limits
    let catchupBytes = 0
    for (const envelope of envelopes) {
        const result = validateBase64UrlEnvelope(envelope, envelopeLimit)
        if (!result.ok) return result
        catchupBytes += decodedBase64UrlBytes(result.value) ?? 0
    }
    if (parsed.type === 'catchup_batch' && catchupBytes > limits.maxCatchupBytes) {
        return { ok: false, code: 'oversized_message', message: 'Catch-up page exceeds the configured byte limit' }
    }
    return { ok: true, value: true }
}

/** The message kinds of each direction. `satisfies` fails when the schemas and these differ. */
const CLIENT_MESSAGE_TYPES = {
    subscribe: 1, unsubscribe: 1, watermarks: 1, append: 1, delete: 1, resurrect: 1, catchup: 1,
    snapshot_put: 1, snapshot_get: 1, snapshot_verified: 1, presence: 1, ack_confirm: 1,
} satisfies Record<SyncClientMessage['type'], 1>
const SERVER_MESSAGE_TYPES = {
    ack: 1, update: 1, snapshot_ack: 1, snapshot_data: 1, catchup_batch: 1, presence: 1,
    epoch_changed: 1, watermarks: 1, error: 1,
} satisfies Record<SyncServerMessage['type'], 1>

/** A message's fields as they came, before anything about them is trusted. */
export type SyncMessageRecord = Readonly<Record<string, unknown>>

/**
 * One version of the wire contract. The engine and the relay work with one set of messages, the
 * current version's, and each version says how those are read and written. A release that raises the
 * protocol version adds an entry and keeps the one before it, so a Sync Server goes on serving Clients
 * a release behind it, and a Client goes on using a server a release behind it.
 */
export interface SyncWireVersion {
    version: number
    clientMessageTypes: ReadonlySet<string>
    serverMessageTypes: ReadonlySet<string>
    clientMessage(limits: SyncProtocolLimits): z.ZodType<SyncClientMessage>
    serverMessage(limits: SyncProtocolLimits): z.ZodType<SyncServerMessage>
    /** A check of the fields as they came, for what a schema that leaves unknown ones out cannot see. */
    acceptsClientMessage?(record: SyncMessageRecord): boolean
    /** The message as this version writes it. Left out, as the engine has it. */
    writeClientMessage?(message: SyncClientMessage): object
    writeServerMessage?(message: SyncServerMessage): object
}

const VERSION_3: SyncWireVersion = {
    version: 3,
    clientMessageTypes: new Set(Object.keys(CLIENT_MESSAGE_TYPES)),
    serverMessageTypes: new Set(Object.keys(SERVER_MESSAGE_TYPES)),
    clientMessage: clientMessageSchema,
    serverMessage: serverMessageSchema,
    // A subscribe to some documents and to all of them says two things, and neither may be ignored.
    acceptsClientMessage: (record) => record.type !== 'subscribe' || !('all' in record && 'docIds' in record),
}

/** Every version this build speaks, oldest first. */
export const SYNC_WIRE_VERSIONS: readonly SyncWireVersion[] = [VERSION_3]

/** The range of a list of versions, which must be in order and leave no gap. */
export function syncVersionRange(versions: readonly SyncWireVersion[]): SyncVersionRange {
    if (versions.length === 0) throw new Error('A sync protocol needs at least one version')
    const min = versions[0].version
    if (versions.some(({ version }, index) => version !== min + index)) {
        throw new Error('The sync protocol versions must be in order, with no gap')
    }
    return { min, max: min + versions.length - 1 }
}

/** The versions this build speaks, as a range. */
export const SYNC_PROTOCOL_RANGE: SyncVersionRange = Object.freeze(syncVersionRange(SYNC_WIRE_VERSIONS))

/** What of a wire version reads one direction. */
interface MessageReader<T> {
    schema: z.ZodType<T>
    types: ReadonlySet<string>
    accepts?: (record: SyncMessageRecord) => boolean
}

/** A message type as a peer may name one: what is not this is a malformed message, not a newer one. */
function isMessageType(type: unknown): type is string {
    return typeof type === 'string' && type.length > 0 && type.length <= 64
}

/** The text as a JSON object within the message limit, or why it is not one. */
function readRecord(raw: string, limits: SyncProtocolLimits): SyncProtocolParseResult<SyncMessageRecord> {
    if (byteLength(raw) > limits.maxMessageBytes) {
        return { ok: false, code: 'oversized_message', message: 'Message exceeds the configured byte limit' }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { ok: false, code: 'invalid_message', message: 'Message is not valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, code: 'invalid_message', message: 'Message must be a JSON object' }
    }
    return { ok: true, value: parsed as SyncMessageRecord }
}

function parseMessage<T>(
    raw: string,
    readers: ReadonlyMap<unknown, MessageReader<T>>,
    limits: SyncProtocolLimits,
): SyncProtocolParseResult<T> {
    const text = readRecord(raw, limits)
    if (!text.ok) return text
    const record = text.value
    const reader = readers.get(record.v)
    if (!reader) {
        return { ok: false, code: 'unsupported_version', message: 'Unsupported sync protocol version' }
    }
    if (isMessageType(record.type) && !reader.types.has(record.type)) {
        return { ok: false, code: 'unknown_type', message: 'Unknown message type' }
    }
    const envelopeResult = envelopePreflight(record, limits)
    if (!envelopeResult.ok) return envelopeResult

    const result = reader.schema.safeParse(record)
    if (!result.success || reader.accepts?.(record) === false) {
        return { ok: false, code: 'invalid_message', message: 'Message does not match the sync protocol' }
    }
    return { ok: true, value: result.data }
}

export interface SyncProtocol {
    readonly limits: SyncProtocolLimits
    /** The versions this protocol reads and writes. */
    readonly range: SyncVersionRange
    parseClientMessage(raw: string): SyncProtocolParseResult<SyncClientMessage>
    parseServerMessage(raw: string): SyncProtocolParseResult<SyncServerMessage>
    /** Written as the version its `v` names has it. */
    serializeClientMessage(message: SyncClientMessage): string
    serializeServerMessage(message: SyncServerMessage): string
}

export function createSyncProtocol(
    overrides: SyncProtocolLimitOverrides = {},
    versions: readonly SyncWireVersion[] = SYNC_WIRE_VERSIONS,
): SyncProtocol {
    const limits = Object.freeze({ ...SYNC_PROTOCOL_LIMITS, ...overrides })
    const range = syncVersionRange(versions)
    const clientReaders = new Map(versions.map((wire) => [wire.version as unknown, {
        schema: wire.clientMessage(limits),
        types: wire.clientMessageTypes,
        accepts: wire.acceptsClientMessage,
    }]))
    const serverReaders = new Map(versions.map((wire) => [wire.version as unknown, {
        schema: wire.serverMessage(limits),
        types: wire.serverMessageTypes,
    }]))

    function wireFor(version: number): SyncWireVersion {
        const wire = versions.find((candidate) => candidate.version === version)
        if (!wire) throw new Error(`unsupported_version: This build does not speak sync protocol ${version}`)
        return wire
    }

    function serialize(message: object): string {
        const raw = JSON.stringify(message)
        if (byteLength(raw) > limits.maxMessageBytes) {
            throw new Error('oversized_message: Message exceeds the configured byte limit')
        }
        return raw
    }

    return {
        limits,
        range,
        parseClientMessage: (raw) => parseMessage(raw, clientReaders, limits),
        parseServerMessage: (raw) => parseMessage(raw, serverReaders, limits),
        serializeClientMessage: (message) => serialize(wireFor(message.v).writeClientMessage?.(message) ?? message),
        serializeServerMessage: (message) => serialize(wireFor(message.v).writeServerMessage?.(message) ?? message),
    }
}

const defaultProtocol = createSyncProtocol()

export const parseClientMessage = defaultProtocol.parseClientMessage
export const parseServerMessage = defaultProtocol.parseServerMessage
export const serializeClientMessage = defaultProtocol.serializeClientMessage
export const serializeServerMessage = defaultProtocol.serializeServerMessage
