import { describe, expect, it } from 'vitest'
import {
    SYNC_PROTOCOL_LIMITS,
    SYNC_PROTOCOL_RANGE,
    SYNC_PROTOCOL_VERSION,
    SYNC_WIRE_VERSIONS,
    createSyncProtocol,
    newestCommonVersion,
    parseClientMessage,
    parseServerMessage,
    readSyncVersionRange,
    serializeClientMessage,
    serializeServerMessage,
    syncVersionRange,
    type SyncClientMessage,
    type SyncServerMessage,
    type SyncWireVersion,
} from './sync-protocol'
import { release0510 } from './testing/released'

/**
 * A Client and a Sync Server are upgraded at different times: an installed app updates by itself, a
 * self-hosted server when its operator gets to it. These tests hold a build to what it must accept
 * from an older or a newer one, and to what it may not become lenient about.
 */

const DOC_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde11234'
const OUTBOX_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde15678'
const append = { v: 3, type: 'append', docId: DOC_ID, outboxId: OUTBOX_ID, generation: 1, epochId: 1, envelope: 'AAEC' }
const update = { v: 3, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' }

describe('the versions a build speaks', () => {
    it('is one range, ending at the current version', () => {
        expect(SYNC_PROTOCOL_RANGE.max).toBe(SYNC_PROTOCOL_VERSION)
        expect(SYNC_PROTOCOL_RANGE).toEqual({ min: 3, max: 3 })
        expect(createSyncProtocol().range).toEqual(SYNC_PROTOCOL_RANGE)
    })

    it.each([
        [{ min: 3, max: 3 }, { min: 3, max: 3 }, 3],
        [{ min: 3, max: 4 }, { min: 3, max: 3 }, 3],
        [{ min: 3, max: 4 }, { min: 4, max: 5 }, 4],
        [{ min: 3, max: 5 }, { min: 2, max: 9 }, 5],
        [{ min: 3, max: 4 }, { min: 5, max: 6 }, null],
        [{ min: 5, max: 6 }, { min: 3, max: 4 }, null],
    ])('takes the newest both speak: %o and %o', (one, other, expected) => {
        expect(newestCommonVersion(one, other)).toBe(expected)
        expect(newestCommonVersion(other, one)).toBe(expected)
    })

    it.each([null, undefined, 'x', 3, [], {}, { min: 3 }, { min: '3', max: 4 }, { min: 4, max: 3 }, { min: 0, max: 3 }, { min: 1.5, max: 3 }, { min: 1, max: 2 ** 53 }])(
        'reads no range out of %o',
        (value) => { expect(readSyncVersionRange(value)).toBeNull() },
    )

    it('reads a range and nothing beside it', () => {
        expect(readSyncVersionRange({ min: 3, max: 4, note: 'x' })).toEqual({ min: 3, max: 4 })
    })
})

describe('what a newer peer adds', () => {
    it('is left out of a message, which is read without it', () => {
        expect(parseClientMessage(JSON.stringify({ ...append, traceId: 'x', nested: { a: 1 } }))).toEqual({ ok: true, value: append })
        expect(parseServerMessage(JSON.stringify({ ...update, editedBy: 'x' }))).toEqual({ ok: true, value: update })
    })

    it('is left out of the parts of a message as well', () => {
        const batch = {
            v: 3, type: 'catchup_batch', requestId: OUTBOX_ID, docId: DOC_ID, generation: 1, state: 'active', throughSeq: 2, hasMore: false,
            updates: [{ seq: 2, epochId: 1, envelope: 'AAEC' }],
            snapshot: { throughSeq: 1, epochId: 1, envelope: 'AAEC' },
        }
        const newer = {
            ...batch, more: 1,
            updates: batch.updates.map((entry) => ({ ...entry, at: 'x' })),
            snapshot: { ...batch.snapshot, at: 'x' },
        }
        expect(parseServerMessage(JSON.stringify(newer))).toEqual({ ok: true, value: batch })
        const marks = { v: 3, type: 'watermarks', requestId: OUTBOX_ID, documents: [{ docId: DOC_ID, generation: 1, state: 'active', lastSeq: 3 }] }
        expect(parseServerMessage(JSON.stringify({ ...marks, documents: [{ ...marks.documents[0], bytes: 9 }] }))).toEqual({ ok: true, value: marks })
    })

    it('is named apart from a malformed message when it is a whole message', () => {
        expect(parseClientMessage(JSON.stringify({ v: 3, type: 'hello', x: 1 }))).toMatchObject({ ok: false, code: 'unknown_type' })
        expect(parseServerMessage(JSON.stringify({ v: 3, type: 'plan_changed' }))).toMatchObject({ ok: false, code: 'unknown_type' })
        // A message of the other direction is as unknown here as any other.
        expect(parseClientMessage(JSON.stringify(update))).toMatchObject({ ok: false, code: 'unknown_type' })
    })

    it.each([[{ v: 3 }], [{ v: 3, type: 5 }], [{ v: 3, type: null }], [{ v: 3, type: '' }], [{ v: 3, type: 'x'.repeat(65) }]])(
        'is not an excuse for a message with no usable type: %o',
        (message) => { expect(parseClientMessage(JSON.stringify(message))).toMatchObject({ ok: false, code: 'invalid_message' }) },
    )

    it('keeps an error whose code is not known, as an unknown one, with what it is about', () => {
        expect(parseServerMessage(JSON.stringify({
            v: 3, type: 'error', code: 'too_busy', message: 'Later', docId: DOC_ID, outboxId: OUTBOX_ID, retryAfter: 5,
        }))).toEqual({
            ok: true,
            value: { v: 3, type: 'error', code: 'unknown_error', message: 'Later', docId: DOC_ID, outboxId: OUTBOX_ID },
        })
        expect(parseServerMessage(JSON.stringify({ v: 3, type: 'error', code: 'x'.repeat(65), message: 'Later' })).ok).toBe(false)
        expect(parseServerMessage(JSON.stringify({ v: 3, type: 'error', code: 7, message: 'Later' })).ok).toBe(false)
    })

    it('keeps a quota refusal whose own code is not known', () => {
        const read = parseServerMessage(JSON.stringify({
            v: 3, type: 'error', code: 'quota_denied', message: 'No', quotaCode: 'too_many_gardens', docId: DOC_ID, outboxId: OUTBOX_ID,
        }))
        expect(read).toMatchObject({ ok: true, value: { code: 'quota_denied', docId: DOC_ID, outboxId: OUTBOX_ID } })
        expect(read.ok && read.value.type === 'error' && read.value.quotaCode).toBeUndefined()
    })
})

describe('what stays strict whoever sent it', () => {
    it.each([
        ['no document', { docId: undefined }],
        ['a document that is not one', { docId: 'garden' }],
        ['no epoch', { epochId: undefined }],
        ['an epoch in words', { epochId: '1' }],
        ['a fraction of a generation', { generation: 1.5 }],
        ['no outbox id', { outboxId: undefined }],
        ['an envelope that is not base64url', { envelope: 'not base64!' }],
        ['no envelope', { envelope: undefined }],
    ])('refuses a write with %s', (_what, change) => {
        expect(parseClientMessage(JSON.stringify({ ...append, ...change, newer: true }))).toMatchObject({ ok: false, code: 'invalid_message' })
    })

    it('refuses a document state it does not know, which says what may be done with the document', () => {
        expect(parseServerMessage(JSON.stringify({ v: 3, type: 'ack', outboxId: OUTBOX_ID, generation: 1, state: 'archived', seq: 3 })).ok).toBe(false)
    })

    it('refuses a subscribe that asks for some documents and for all of them', () => {
        expect(parseClientMessage(JSON.stringify({ v: 3, type: 'subscribe', all: true, docIds: [DOC_ID] })).ok).toBe(false)
        expect(parseClientMessage(JSON.stringify({ v: 3, type: 'subscribe', all: true, label: 'x' }))).toEqual({ ok: true, value: { v: 3, type: 'subscribe', all: true } })
    })

    it('keeps every size and count limit, with or without fields it does not know', () => {
        const protocol = createSyncProtocol({ maxEnvelopeBytes: 3, maxSubscriptionDocIds: 2, maxMessageBytes: 400 })
        expect(protocol.parseClientMessage(JSON.stringify({ ...append, envelope: 'AAECAQ', newer: true }))).toMatchObject({ code: 'oversized_message' })
        expect(protocol.parseClientMessage(JSON.stringify({ v: 3, type: 'subscribe', docIds: [DOC_ID, DOC_ID, DOC_ID], newer: true })).ok).toBe(false)
        expect(protocol.parseClientMessage(JSON.stringify({ ...append, newer: 'x'.repeat(400) }))).toMatchObject({ code: 'oversized_message' })
        // An unknown message is bounded by the message limit like any other.
        expect(protocol.parseClientMessage(JSON.stringify({ v: 3, type: 'hello', x: 'x'.repeat(400) }))).toMatchObject({ code: 'oversized_message' })
    })

    it('never takes a field from a prototype', () => {
        const read = parseClientMessage(`{"v":3,"type":"unsubscribe","docIds":[],"__proto__":{"all":true}}`)
        expect(read).toEqual({ ok: true, value: { v: 3, type: 'unsubscribe', docIds: [] } })
    })
})

describe('beside release 0.51.0', () => {
    it('reads every frame a 0.51.0 Client sends, as it was', () => {
        expect(release0510.clientFrames.length).toBeGreaterThan(12)
        for (const frame of release0510.clientFrames) {
            expect(parseClientMessage(frame), frame).toEqual({ ok: true, value: JSON.parse(frame) })
        }
    })

    it('reads every frame a 0.51.0 Sync Server sends, as it was', () => {
        expect(release0510.serverFrames.length).toBeGreaterThan(14)
        for (const frame of release0510.serverFrames) {
            expect(parseServerMessage(frame), frame).toEqual({ ok: true, value: JSON.parse(frame) })
        }
    })

    it('sends nothing a 0.51.0 peer refuses, when it sends the same messages', () => {
        for (const frame of release0510.clientFrames) {
            const read = parseClientMessage(frame)
            if (!read.ok) throw new Error(frame)
            expect(release0510.serverReads(serializeClientMessage(read.value)), frame).toMatchObject({ ok: true })
        }
        for (const frame of release0510.serverFrames) {
            const read = parseServerMessage(frame)
            if (!read.ok) throw new Error(frame)
            expect(release0510.clientReads(serializeServerMessage(read.value)), frame).toMatchObject({ ok: true })
        }
    })

    // Why additions wait for a peer that says it can take them: 0.51.0 drops a message for one field.
    it('is the release that refuses an added field', () => {
        expect(release0510.clientReads(JSON.stringify({ ...update, editedBy: 'x' })).ok).toBe(false)
        expect(release0510.serverReads(JSON.stringify({ ...append, traceId: 'x' })).ok).toBe(false)
    })
})

describe('a version after this one', () => {
    /** Version 4, as a later release might have it: an append names its size, and 3 does not. */
    const next: SyncWireVersion = {
        ...SYNC_WIRE_VERSIONS[SYNC_WIRE_VERSIONS.length - 1],
        version: 4,
        writeClientMessage: (message) => message.type === 'append' ? { ...message, bytes: message.envelope.length } : message,
        acceptsClientMessage: (record) => record.type !== 'append' || typeof record.bytes === 'number',
    }
    const both = createSyncProtocol({}, [...SYNC_WIRE_VERSIONS, next])
    const onlyNext = createSyncProtocol({}, [next])
    const message = append as SyncClientMessage

    it('is spoken beside this one by a peer that has both', () => {
        expect(both.range).toEqual({ min: 3, max: 4 })
        expect(syncVersionRange([next])).toEqual({ min: 4, max: 4 })
        const asThree = both.serializeClientMessage({ ...message, v: 3 })
        const asFour = both.serializeClientMessage({ ...message, v: 4 })
        expect(JSON.parse(asThree)).toEqual(append)
        expect(JSON.parse(asFour)).toEqual({ ...append, v: 4, bytes: 4 })
        // Both are read, each by its own version's rules, into the one message the engine works with.
        expect(both.parseClientMessage(asThree)).toEqual({ ok: true, value: append })
        expect(both.parseClientMessage(asFour)).toEqual({ ok: true, value: { ...append, v: 4 } })
        expect(both.parseClientMessage(JSON.stringify({ ...append, v: 4 }))).toMatchObject({ ok: false, code: 'invalid_message' })
    })

    it('is refused by name by a peer that has only one of them', () => {
        expect(createSyncProtocol().parseClientMessage(both.serializeClientMessage({ ...message, v: 4 }))).toMatchObject({ ok: false, code: 'unsupported_version' })
        expect(onlyNext.parseClientMessage(JSON.stringify(append))).toMatchObject({ ok: false, code: 'unsupported_version' })
    })

    it('cannot be written by a build that does not speak it', () => {
        expect(() => createSyncProtocol().serializeClientMessage({ ...message, v: 4 })).toThrow('unsupported_version')
        expect(() => createSyncProtocol().serializeServerMessage({ ...(update as SyncServerMessage), v: 4 })).toThrow('unsupported_version')
    })

    it('must leave no gap in the range, and no version twice', () => {
        expect(() => createSyncProtocol({}, [...SYNC_WIRE_VERSIONS, { ...next, version: 5 }])).toThrow()
        expect(() => createSyncProtocol({}, [next, next])).toThrow()
        expect(() => createSyncProtocol({}, [])).toThrow()
    })

    it('tells a refused peer which versions there are', () => {
        const refusal: SyncServerMessage = { v: 3, type: 'error', code: 'unsupported_version', message: 'No', supported: { min: 4, max: 5 } }
        expect(parseServerMessage(serializeServerMessage(refusal))).toEqual({ ok: true, value: refusal })
        // A range that makes no sense is left out, and the refusal kept.
        expect(parseServerMessage(JSON.stringify({ ...refusal, supported: { min: 9, max: 1 } }))).toMatchObject({ ok: true, value: { code: 'unsupported_version' } })
    })
})

it('keeps the default limits it had', () => {
    expect(createSyncProtocol().limits).toEqual(SYNC_PROTOCOL_LIMITS)
})
