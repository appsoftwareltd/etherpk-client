import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
    parseClientMessage,
    parseServerMessage,
    readSyncConnect,
    serializeClientMessage,
    serializeServerMessage,
    syncConnectUrl,
    type SyncClientMessage,
    type SyncServerMessage,
} from '@appsoftwareltd/etherpk-shared'
import { release0510 } from '@appsoftwareltd/etherpk-shared/released-sync'

/**
 * How many cases a property runs, and from which seed. The seed is fixed so a run is the same here
 * and in CI. `SYNC_FUZZ_RUNS` and `SYNC_FUZZ_SEED` change them for a longer local run, or to replay a
 * failure fast-check reported.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SYNC_FUZZ_SEED
    return { numRuns: Number(process.env.SYNC_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261125 : Number(seed) }
}

/**
 * Peers of other releases add fields and messages. Whatever they add, the part both know is read as it
 * was sent, nothing added gets through, and what a build sends is what 0.51.0 accepts.
 */

const uuid = fc.uuid()
const whole = fc.integer({ min: 0, max: 1_000_000 })
const generation = fc.integer({ min: 1, max: 1_000 })
const envelope = fc.uint8Array({ minLength: 1, maxLength: 40 }).map((bytes) => Buffer.from(bytes).toString('base64url'))
const v = fc.constant(3)
const state = fc.constantFrom('active' as const, 'deleted' as const)
const type = <T extends string>(value: T) => fc.constant(value)

const clientMessage: fc.Arbitrary<SyncClientMessage> = fc.oneof(
    fc.record({ v, type: type('subscribe'), docIds: fc.array(uuid, { maxLength: 4 }) }),
    fc.record({ v, type: type('subscribe'), all: fc.constant(true as const) }),
    fc.record({ v, type: type('unsubscribe'), docIds: fc.array(uuid, { maxLength: 4 }) }),
    fc.record({ v, type: type('watermarks'), requestId: uuid, docIds: fc.array(uuid, { minLength: 1, maxLength: 4 }) }),
    fc.record({ v, type: type('append'), docId: uuid, outboxId: uuid, generation, epochId: whole, envelope }),
    fc.record({ v, type: type('delete'), docId: uuid, outboxId: uuid, generation }),
    fc.record({ v, type: type('resurrect'), docId: uuid, outboxId: uuid, generation, epochId: whole, envelope }),
    fc.record({
        v, type: type('catchup'), requestId: uuid, docId: uuid, generation, afterSeq: whole,
        priority: fc.constantFrom('foreground' as const, 'background' as const),
        maxRows: fc.integer({ min: 1, max: 256 }), maxBytes: fc.integer({ min: 1, max: 8 * 1024 * 1024 }),
    }),
    fc.record({ v, type: type('snapshot_put'), docId: uuid, generation, throughSeq: whole, epochId: whole, envelope }),
    fc.record({ v, type: type('snapshot_get'), docId: uuid, generation, throughSeq: whole }),
    fc.record({ v, type: type('snapshot_verified'), docId: uuid, generation, throughSeq: whole }),
    fc.record({ v, type: type('presence'), docId: uuid, epochId: whole, envelope }),
    fc.record({ v, type: type('ack_confirm'), outboxId: uuid }),
)

const update = fc.record({ seq: whole, epochId: whole, envelope })
/** What the relay sends a Client that did not declare itself: everything but `supported`. */
const serverMessage: fc.Arbitrary<SyncServerMessage> = fc.oneof(
    fc.record({ v, type: type('ack'), outboxId: uuid, generation, state, seq: whole }),
    fc.record({ v, type: type('update'), docId: uuid, generation, seq: whole, epochId: whole, envelope }),
    fc.record({ v, type: type('snapshot_ack'), docId: uuid, generation, throughSeq: whole }),
    fc.record({ v, type: type('snapshot_data'), docId: uuid, generation, throughSeq: whole, epochId: whole, envelope }),
    fc.record({
        v, type: type('catchup_batch'), requestId: uuid, docId: uuid, generation, state, throughSeq: whole, hasMore: fc.boolean(),
        updates: fc.array(update, { maxLength: 3 }),
        snapshot: fc.record({ throughSeq: whole, epochId: whole, envelope }),
    }, { requiredKeys: ['v', 'type', 'docId', 'generation', 'state', 'throughSeq', 'hasMore', 'updates'] }),
    fc.record({ v, type: type('presence'), docId: uuid, envelope }),
    fc.record({ v, type: type('epoch_changed'), epoch: generation }),
    fc.record({ v, type: type('watermarks'), requestId: uuid, documents: fc.array(fc.record({ docId: uuid, generation, state, lastSeq: whole }), { maxLength: 3 }) }),
    fc.record({
        v, type: type('error'),
        code: fc.constantFrom('invalid_message' as const, 'stale_generation' as const, 'quota_denied' as const, 'stale_epoch' as const, 'internal_error' as const),
        message: fc.string({ minLength: 1, maxLength: 60 }),
        docId: uuid, outboxId: uuid, currentGeneration: generation, currentEpoch: generation,
        quotaCode: fc.constantFrom('owned_storage_limit' as const, 'entitlement_inactive' as const), retryable: fc.boolean(),
    }, { requiredKeys: ['v', 'type', 'code', 'message'] }),
)

/** Names no message has, so an addition never replaces a field that is known. */
const additions = fc.dictionary(fc.stringMatching(/^x[a-z]{1,8}$/), fc.jsonValue(), { minKeys: 1, maxKeys: 4 })
/** The same additions in every object of a message, as a later release might make them. */
function addTo(value: unknown, added: Record<string, unknown>): unknown {
    if (Array.isArray(value)) return value.map((entry) => addTo(entry, added))
    if (typeof value !== 'object' || value === null) return value
    return { ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, addTo(entry, added)])), ...added }
}

describe('a message from a newer peer', () => {
    it('is read as the part of it that is known, whatever was added and wherever', () => {
        fc.assert(fc.property(clientMessage, additions, (message, added) => {
            expect(parseClientMessage(JSON.stringify(addTo(message, added)))).toEqual({ ok: true, value: message })
        }), fuzz(300))
        fc.assert(fc.property(serverMessage, additions, (message, added) => {
            expect(parseServerMessage(JSON.stringify(addTo(message, added)))).toEqual({ ok: true, value: message })
        }), fuzz(300))
    })

    it('of a kind that is not known is never taken for one that is', () => {
        fc.assert(fc.property(clientMessage, fc.stringMatching(/^x[a-z_]{1,20}$/), (message, kind) => {
            expect(parseClientMessage(JSON.stringify({ ...message, type: kind }))).toMatchObject({ ok: false, code: 'unknown_type' })
        }), fuzz(100))
    })
})

describe('a message with a known field missing', () => {
    it('is refused, whatever was added', () => {
        fc.assert(fc.property(clientMessage, additions, fc.nat(), (message, added, pick) => {
            const keys = Object.keys(message)
            const without: Record<string, unknown> = { ...message, ...added }
            delete without[keys[pick % keys.length]]
            expect(parseClientMessage(JSON.stringify(without)).ok).toBe(false)
        }), fuzz(300))
    })
})

describe('a message this build sends', () => {
    it('is one 0.51.0 reads as it was', () => {
        fc.assert(fc.property(clientMessage, (message) => {
            expect(release0510.serverReads(serializeClientMessage(message))).toEqual({ ok: true, value: message })
        }), fuzz(300))
        fc.assert(fc.property(serverMessage, (message) => {
            expect(release0510.clientReads(serializeServerMessage(message))).toEqual({ ok: true, value: message })
        }), fuzz(300))
    })
})

describe('what a Client says of itself', () => {
    it('reads back as it was said, and any text reads back as nothing worse than nothing', () => {
        const info = fc.record({
            kind: fc.constantFrom('web' as const, 'installed' as const, 'headless' as const),
            version: fc.tuple(fc.nat(9999), fc.nat(9999), fc.nat(9999)).map((parts) => parts.join('.')),
        })
        fc.assert(fc.property(info, fc.integer({ min: 1, max: 99_999 }), fc.string({ minLength: 1 }), (client, version, token) => {
            const query = new URL(syncConnectUrl('wss://garden.example/sync', token, version, client)).searchParams
            expect(query.get('token')).toBe(token)
            expect(readSyncConnect(query)).toEqual({ declared: true, version, client })
        }), fuzz(200))
        fc.assert(fc.property(fc.string(), fc.string(), (one, other) => {
            const read = readSyncConnect(new URLSearchParams({ v: one, client: other }))
            expect(Number.isSafeInteger(read.version)).toBe(true)
            if (read.client) expect(`${read.client.kind}/${read.client.version}`).toBe(other)
        }), fuzz(200))
    })
})
