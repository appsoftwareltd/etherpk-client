import { z } from 'zod'
import { quotaErrorCodeSchema } from './managed-service'

export const SYNC_PROTOCOL_VERSION = 2 as const

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
     * Sockets one user may hold open on one graph. Every browser tab holds its own socket, so
     * this is well above ordinary duplicate-tab use and only bites a script.
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
    maxSocketsPerUserGraph: 10,
})

export type SyncProtocolLimitOverrides = Partial<SyncProtocolLimits>

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
    'internal_error',
] as const

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]

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

function clientMessageSchema(limits: SyncProtocolLimits) {
    const version = z.literal(SYNC_PROTOCOL_VERSION)
    const presenceEnvelope = presenceEnvelopeSchema(limits)
    const subscribe = z.union([
        z.object({ v: version, type: z.literal('subscribe'), all: z.literal(true) }).strict(),
        z
            .object({
                v: version,
                type: z.literal('subscribe'),
                docIds: z.array(uuid).max(limits.maxSubscriptionDocIds),
            })
            .strict(),
    ])

    return z.discriminatedUnion('type', [
        // Zod cannot discriminate the two subscribe shapes itself, so validate their union
        // as one schema in a final outer union below.
        z
            .object({
                v: version,
                type: z.literal('unsubscribe'),
                docIds: z.array(uuid).max(limits.maxSubscriptionDocIds),
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('watermarks'),
                requestId: uuid,
                docIds: z.array(uuid).min(1).max(limits.maxSubscriptionDocIds),
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('append'),
                docId: uuid,
                outboxId: uuid,
                generation,
                epochId: safeInteger,
                envelope: base64Url,
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('delete'),
                docId: uuid,
                outboxId: uuid,
                generation,
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('resurrect'),
                docId: uuid,
                outboxId: uuid,
                generation,
                epochId: safeInteger,
                envelope: base64Url,
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('catchup'),
                requestId: uuid,
                docId: uuid,
                generation,
                afterSeq: safeInteger,
                priority: z.enum(['foreground', 'background']),
                maxRows: z.number().int().positive().max(limits.maxCatchupRows),
                maxBytes: z.number().int().positive().max(limits.maxCatchupBytes),
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('snapshot_put'),
                docId: uuid,
                generation,
                throughSeq: safeInteger,
                epochId: safeInteger,
                envelope: base64Url,
            })
            .strict(),
        // Read-back verification (ADR 0025, amended 2026-09-12): the compacting client asks
        // for the snapshot it just stored, decodes it, and only then declares it verified.
        // The relay prunes history only behind a verified snapshot.
        z
            .object({
                v: version,
                type: z.literal('snapshot_get'),
                docId: uuid,
                generation,
                throughSeq: safeInteger,
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('snapshot_verified'),
                docId: uuid,
                generation,
                throughSeq: safeInteger,
            })
            .strict(),
        z.object({ v: version, type: z.literal('presence'), docId: uuid, envelope: presenceEnvelope }).strict(),
        z.object({ v: version, type: z.literal('ack_confirm'), outboxId: uuid }).strict(),
    ]).or(subscribe)
}

function serverMessageSchema(limits: SyncProtocolLimits) {
    const version = z.literal(SYNC_PROTOCOL_VERSION)
    const presenceEnvelope = presenceEnvelopeSchema(limits)
    const update = z
        .object({
            seq: safeInteger,
            epochId: safeInteger,
            envelope: base64Url,
        })
        .strict()
    const snapshot = z
        .object({
            throughSeq: safeInteger,
            epochId: safeInteger,
            envelope: base64Url,
        })
        .strict()

    return z.discriminatedUnion('type', [
        z
            .object({
                v: version,
                type: z.literal('ack'),
                outboxId: uuid,
                generation,
                state: z.enum(['active', 'deleted']),
                seq: safeInteger,
            })
            .strict(),
        z.object({ v: version, type: z.literal('update'), docId: uuid, generation }).extend(update.shape).strict(),
        /** The relay stored a snapshot_put; the client may now read it back. */
        z
            .object({
                v: version,
                type: z.literal('snapshot_ack'),
                docId: uuid,
                generation,
                throughSeq: safeInteger,
            })
            .strict(),
        /** The stored snapshot, served back by exact identity for verification. */
        z
            .object({
                v: version,
                type: z.literal('snapshot_data'),
                docId: uuid,
                generation,
                throughSeq: safeInteger,
                epochId: safeInteger,
                envelope: base64Url,
            })
            .strict(),
        z
            .object({
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
            })
            .strict(),
        z.object({ v: version, type: z.literal('presence'), docId: uuid, envelope: presenceEnvelope }).strict(),
        z
            .object({
                v: version,
                type: z.literal('watermarks'),
                requestId: uuid,
                documents: z
                    .array(
                        z
                            .object({
                                docId: uuid,
                                generation,
                                state: z.enum(['active', 'deleted']),
                                lastSeq: safeInteger,
                            })
                            .strict(),
                    )
                    .max(limits.maxSubscriptionDocIds),
            })
            .strict(),
        z
            .object({
                v: version,
                type: z.literal('error'),
                code: z.enum(SYNC_ERROR_CODES),
                message: z.string().min(1).max(256),
                docId: uuid.optional(),
                /**
                 * The outbox operation a `quota_denied` refused (append, delete or resurrect), so
                 * the client retries that operation rather than waiting for an ack that never comes.
                 * Absent for a refused snapshot, which is not an outbox operation.
                 */
                outboxId: uuid.optional(),
                currentGeneration: generation.optional(),
                quotaCode: quotaErrorCodeSchema.optional(),
                retryable: z.boolean().optional(),
            })
            .strict(),
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
    | { ok: false; code: 'unsupported_version' | 'invalid_message' | 'oversized_message'; message: string }

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
    parsed: Record<string, unknown>,
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

function parseMessage<T>(
    raw: string,
    schema: z.ZodType<T>,
    limits: SyncProtocolLimits,
): SyncProtocolParseResult<T> {
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
    const record = parsed as Record<string, unknown>
    if (record.v !== SYNC_PROTOCOL_VERSION) {
        return { ok: false, code: 'unsupported_version', message: 'Unsupported sync protocol version' }
    }
    const envelopeResult = envelopePreflight(record, limits)
    if (!envelopeResult.ok) return envelopeResult

    const result = schema.safeParse(parsed)
    if (!result.success) {
        return { ok: false, code: 'invalid_message', message: 'Message does not match the sync protocol' }
    }
    return { ok: true, value: result.data }
}

export interface SyncProtocol {
    readonly limits: SyncProtocolLimits
    parseClientMessage(raw: string): SyncProtocolParseResult<SyncClientMessage>
    parseServerMessage(raw: string): SyncProtocolParseResult<SyncServerMessage>
    serializeClientMessage(message: SyncClientMessage): string
    serializeServerMessage(message: SyncServerMessage): string
}

export function createSyncProtocol(overrides: SyncProtocolLimitOverrides = {}): SyncProtocol {
    const limits = Object.freeze({ ...SYNC_PROTOCOL_LIMITS, ...overrides })
    const clientSchema = clientMessageSchema(limits)
    const serverSchema = serverMessageSchema(limits)

    const parseClient = (raw: string) => parseMessage(raw, clientSchema, limits)
    const parseServer = (raw: string) => parseMessage(raw, serverSchema, limits)

    function serialize<T>(message: T): string {
        const raw = JSON.stringify(message)
        if (byteLength(raw) > limits.maxMessageBytes) {
            throw new Error('oversized_message: Message exceeds the configured byte limit')
        }
        return raw
    }

    return {
        limits,
        parseClientMessage: parseClient,
        parseServerMessage: parseServer,
        serializeClientMessage: (message) => serialize(message),
        serializeServerMessage: (message) => serialize(message),
    }
}

const defaultProtocol = createSyncProtocol()

export const parseClientMessage = defaultProtocol.parseClientMessage
export const parseServerMessage = defaultProtocol.parseServerMessage
export const serializeClientMessage = defaultProtocol.serializeClientMessage
export const serializeServerMessage = defaultProtocol.serializeServerMessage
