import { describe, expect, it } from 'vitest'
import {
    SYNC_PROTOCOL_LIMITS,
    SYNC_PROTOCOL_VERSION,
    createSyncProtocol,
    parseClientMessage,
    parseServerMessage,
    serializeClientMessage,
    serializeServerMessage,
    type SyncClientMessage,
    type SyncServerMessage,
} from './sync-protocol'

const DOC_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde11234'
const OUTBOX_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde15678'

describe('shared sync protocol', () => {
    it('pins the protocol version and production limits', () => {
        expect(SYNC_PROTOCOL_VERSION).toBe(2)
        expect(SYNC_PROTOCOL_LIMITS).toEqual({
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
    })

    it('round-trips every client message kind', () => {
        const messages: SyncClientMessage[] = [
            { v: 2, type: 'subscribe', docIds: [DOC_ID] },
            { v: 2, type: 'subscribe', all: true },
            { v: 2, type: 'unsubscribe', docIds: [DOC_ID] },
            { v: 2, type: 'watermarks', requestId: OUTBOX_ID, docIds: [DOC_ID] },
            { v: 2, type: 'append', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 1, epochId: 1, envelope: 'AAEC' },
            { v: 2, type: 'delete', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 1 },
            { v: 2, type: 'resurrect', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 2, epochId: 1, envelope: 'AAEC' },
            {
                v: 2,
                type: 'catchup',
                requestId: OUTBOX_ID,
                docId: DOC_ID,
                generation: 1,
                afterSeq: 0,
                priority: 'foreground',
                maxRows: 256,
                maxBytes: 8 * 1024 * 1024,
            },
            { v: 2, type: 'snapshot_put', docId: DOC_ID, generation: 1, throughSeq: 9, epochId: 1, envelope: 'AAEC' },
            { v: 2, type: 'snapshot_get', docId: DOC_ID, generation: 1, throughSeq: 9 },
            { v: 2, type: 'snapshot_verified', docId: DOC_ID, generation: 1, throughSeq: 9 },
            { v: 2, type: 'presence', docId: DOC_ID, envelope: 'AAEC' },
            { v: 2, type: 'ack_confirm', outboxId: OUTBOX_ID },
        ]

        for (const message of messages) {
            expect(parseClientMessage(serializeClientMessage(message))).toEqual({ ok: true, value: message })
        }
    })

    it('round-trips every server message kind', () => {
        const messages: SyncServerMessage[] = [
            { v: 2, type: 'ack', outboxId: OUTBOX_ID, generation: 1, state: 'active', seq: 3 },
            { v: 2, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' },
            {
                v: 2,
                type: 'catchup_batch',
                requestId: OUTBOX_ID,
                docId: DOC_ID,
                generation: 1,
                state: 'active',
                throughSeq: 2,
                hasMore: false,
                updates: [{ seq: 2, epochId: 1, envelope: 'AAEC' }],
                snapshot: { throughSeq: 1, epochId: 1, envelope: 'AAEC' },
            },
            { v: 2, type: 'catchup_batch', docId: DOC_ID, generation: 2, state: 'deleted', throughSeq: 0, hasMore: false, updates: [] },
            { v: 2, type: 'snapshot_ack', docId: DOC_ID, generation: 1, throughSeq: 9 },
            { v: 2, type: 'snapshot_data', docId: DOC_ID, generation: 1, throughSeq: 9, epochId: 1, envelope: 'AAEC' },
            { v: 2, type: 'error', code: 'snapshot_missing', message: 'No such snapshot', docId: DOC_ID },
            { v: 2, type: 'presence', docId: DOC_ID, envelope: 'AAEC' },
            {
                v: 2,
                type: 'watermarks',
                requestId: OUTBOX_ID,
                documents: [
                    {
                        docId: DOC_ID,
                        generation: 1,
                        state: 'active',
                        lastSeq: 3,
                    },
                ],
            },
            { v: 2, type: 'error', code: 'stale_generation', message: 'Stale document generation', docId: DOC_ID, currentGeneration: 2 },
            { v: 2, type: 'error', code: 'quota_denied', message: 'Managed Sync write allowance reached', quotaCode: 'owned_storage_limit', retryable: true },
            { v: 2, type: 'error', code: 'subscription_limit', message: 'Too many subscriptions on this connection' },
        ]

        for (const message of messages) {
            expect(parseServerMessage(serializeServerMessage(message))).toEqual({ ok: true, value: message })
        }
    })

    it('bounds a snapshot read-back envelope like any other content envelope', () => {
        // The read-back carries the whole consolidated document, so it shares the content
        // ceiling, and the preflight must refuse it before anything decodes it.
        const protocol = createSyncProtocol({ maxEnvelopeBytes: 3 })
        expect(
            protocol.parseServerMessage(
                JSON.stringify({ v: 2, type: 'snapshot_data', docId: DOC_ID, generation: 1, throughSeq: 1, epochId: 1, envelope: 'AAECAQ' }),
            ),
        ).toMatchObject({ ok: false, code: 'oversized_message' })
        expect(
            protocol.parseServerMessage(
                JSON.stringify({ v: 2, type: 'snapshot_data', docId: DOC_ID, generation: 1, throughSeq: 1, epochId: 1, envelope: 'AAEC' }),
            ),
        ).toMatchObject({ ok: true })
    })

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
        'rejects invalid sequence and epoch numbers: %s',
        (value) => {
            const afterSeq = JSON.stringify({
                v: 2,
                type: 'catchup',
                requestId: OUTBOX_ID,
                docId: DOC_ID,
                generation: 1,
                afterSeq: value,
                priority: 'foreground',
                maxRows: 256,
                maxBytes: 1024,
            })
            expect(parseClientMessage(afterSeq)).toMatchObject({ ok: false, code: 'invalid_message' })

            const epoch = JSON.stringify({
                v: 2,
                type: 'append',
                docId: DOC_ID,
                outboxId: OUTBOX_ID,
                epochId: value,
                envelope: 'AAEC',
            })
            expect(parseClientMessage(epoch)).toMatchObject({ ok: false, code: 'invalid_message' })
        },
    )

    it('requires UUID identifiers and non-empty strict fields', () => {
        expect(
            parseClientMessage(
                JSON.stringify({ v: 2, type: 'append', docId: 'd1', outboxId: OUTBOX_ID, epochId: 1, envelope: 'AAEC' }),
            ),
        ).toMatchObject({ ok: false, code: 'invalid_message' })
        expect(
            parseClientMessage(
                JSON.stringify({ v: 2, type: 'append', docId: DOC_ID, outboxId: '', epochId: 1, envelope: 'AAEC' }),
            ),
        ).toMatchObject({ ok: false, code: 'invalid_message' })
        expect(
            parseClientMessage(
                JSON.stringify({
                    v: 2,
                    type: 'catchup',
                    requestId: OUTBOX_ID,
                    docId: DOC_ID,
                    generation: 1,
                    afterSeq: 0,
                    priority: 'foreground',
                    maxRows: 256,
                    maxBytes: 1024,
                    surprise: true,
                }),
            ),
        ).toMatchObject({ ok: false, code: 'invalid_message' })
    })

    it('rejects malformed base64url and enforces decoded envelope bytes before decoding', () => {
        const protocol = createSyncProtocol({ maxEnvelopeBytes: 3 })
        const append = (envelope: string) =>
            JSON.stringify({ v: 2, type: 'append', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 1, epochId: 1, envelope })

        expect(protocol.parseClientMessage(append('AAEC'))).toMatchObject({ ok: true })
        expect(protocol.parseClientMessage(append('not+base64'))).toMatchObject({ ok: false, code: 'invalid_message' })
        expect(protocol.parseClientMessage(append('A'))).toMatchObject({ ok: false, code: 'invalid_message' })
        expect(protocol.parseClientMessage(append('AAECAQ'))).toMatchObject({ ok: false, code: 'oversized_message' })
    })

    it('bounds a presence envelope far more tightly than a content envelope, in both directions', () => {
        // A real awareness update is a few hundred bytes. Sharing the 8 MiB content ceiling
        // would let one stored envelope be replayed to every late subscriber at that size,
        // with no database work to slow it down.
        const protocol = createSyncProtocol({ maxPresenceEnvelopeBytes: 3 })
        const presence = (envelope: string) => JSON.stringify({ v: 2, type: 'presence', docId: DOC_ID, envelope })

        expect(protocol.parseClientMessage(presence('AAEC'))).toMatchObject({ ok: true })
        expect(protocol.parseClientMessage(presence('AAECAQ'))).toMatchObject({ ok: false, code: 'oversized_message' })
        // The relay's own presence messages (broadcast and late-join replay) carry the same bound.
        expect(protocol.parseServerMessage(presence('AAEC'))).toMatchObject({ ok: true })
        expect(protocol.parseServerMessage(presence('AAECAQ'))).toMatchObject({ ok: false, code: 'oversized_message' })
        // Content envelopes keep their own, larger ceiling.
        expect(
            protocol.parseClientMessage(
                JSON.stringify({ v: 2, type: 'append', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 1, epochId: 1, envelope: 'AAECAQ' }),
            ),
        ).toMatchObject({ ok: true })
        // The default is 16 KiB, checked on the DECODED size (unpadded base64url grows 4/3).
        const unpaddedLength = (bytes: number) => Math.ceil((bytes * 4) / 3)
        expect(parseClientMessage(presence('A'.repeat(unpaddedLength(16 * 1024))))).toMatchObject({ ok: true })
        expect(parseClientMessage(presence('A'.repeat(unpaddedLength(16 * 1024 + 1))))).toMatchObject({
            ok: false,
            code: 'oversized_message',
        })
    })

    it('bounds the raw message before JSON parsing and supports a configuration override', () => {
        const protocol = createSyncProtocol({ maxMessageBytes: 64 })
        expect(protocol.limits.maxMessageBytes).toBe(64)
        expect(protocol.parseClientMessage('x'.repeat(65))).toEqual({
            ok: false,
            code: 'oversized_message',
            message: 'Message exceeds the configured byte limit',
        })
    })

    it('bounds subscription lists and catch-up pages by rows and decoded bytes', () => {
        const protocol = createSyncProtocol({
            maxSubscriptionDocIds: 1,
            maxCatchupRows: 1,
            maxCatchupBytes: 6,
        })
        expect(
            protocol.parseClientMessage(
                JSON.stringify({ v: 2, type: 'subscribe', docIds: [DOC_ID, '018f47a0-7b5d-7cc5-b5c1-f0fbcde19999'] }),
            ),
        ).toMatchObject({ ok: false, code: 'invalid_message' })

        const tooManyRows = {
            v: 2,
            type: 'catchup_batch',
            docId: DOC_ID,
            updates: [
                { seq: 1, epochId: 1, envelope: 'AAEC' },
                { seq: 2, epochId: 1, envelope: 'AAEC' },
            ],
        }
        expect(protocol.parseServerMessage(JSON.stringify(tooManyRows))).toMatchObject({
            ok: false,
            code: 'invalid_message',
        })

        const tooManyBytes = {
            v: 2,
            type: 'catchup_batch',
            docId: DOC_ID,
            updates: [{ seq: 1, epochId: 1, envelope: 'AAECAQ' }],
        }
        expect(createSyncProtocol({ maxCatchupBytes: 3 }).parseServerMessage(JSON.stringify(tooManyBytes))).toMatchObject({
            ok: false,
            code: 'oversized_message',
        })
    })

    it('rejects unsupported or missing protocol versions with a stable code', () => {
        expect(parseClientMessage(JSON.stringify({ v: 1, type: 'subscribe', all: true }))).toEqual({
            ok: false,
            code: 'unsupported_version',
            message: 'Unsupported sync protocol version',
        })
        expect(parseClientMessage(JSON.stringify({ type: 'subscribe', all: true }))).toEqual({
            ok: false,
            code: 'unsupported_version',
            message: 'Unsupported sync protocol version',
        })
    })
})
