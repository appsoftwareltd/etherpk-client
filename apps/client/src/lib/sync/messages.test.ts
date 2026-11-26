import { describe, expect, it } from 'vitest'
import { SyncProtocolMismatchError, parseServerMessage, readServerMessage, serializeClientMessage } from './messages'

const DOC_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde11234'

describe('client sync protocol boundary', () => {
    it('adds protocol v2 to outbound messages', () => {
        expect(JSON.parse(serializeClientMessage({ type: 'subscribe', docIds: [DOC_ID] }))).toEqual({
            v: 3,
            type: 'subscribe',
            docIds: [DOC_ID],
        })
    })

    it('accepts shared v2 server messages and removes the transport version', () => {
        expect(
            parseServerMessage(JSON.stringify({ v: 3, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })),
        ).toEqual({ type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })
    })

    it('rejects unversioned and malformed messages through the shared parser', () => {
        expect(parseServerMessage(JSON.stringify({ type: 'presence', docId: DOC_ID, envelope: 'AAEC' }))).toBeNull()
        expect(parseServerMessage('not json')).toBeNull()
    })

    it('reads the range of a server that speaks other versions', () => {
        // 0.51.0 and earlier answer in the one version they speak, and name no range.
        expect(readServerMessage(JSON.stringify({ v: 4, type: 'error', code: 'unsupported_version' }))).toEqual({
            kind: 'version_refused',
            serverRange: { min: 4, max: 4 },
        })
        expect(readServerMessage(JSON.stringify({ v: 1, type: 'ack', outboxId: 'x' }))).toEqual({
            kind: 'version_refused',
            serverRange: { min: 1, max: 1 },
        })
        // Later ones name it, in a version this Client may or may not read.
        for (const v of [3, 5]) {
            expect(readServerMessage(JSON.stringify({ v, type: 'error', code: 'unsupported_version', message: 'No', supported: { min: 4, max: 5 } }))).toEqual({
                kind: 'version_refused',
                serverRange: { min: 4, max: 5 },
            })
        }
        // A range that makes no sense is no range.
        expect(readServerMessage(JSON.stringify({ v: 5, type: 'error', code: 'unsupported_version', supported: { min: 9, max: 1 } }))).toEqual({
            kind: 'version_refused',
            serverRange: { min: 5, max: 5 },
        })
    })

    it('passes over a message of a kind it does not know', () => {
        expect(readServerMessage(JSON.stringify({ v: 3, type: 'plan_changed', plan: 'x' }))).toEqual({ kind: 'unknown' })
        expect(parseServerMessage(JSON.stringify({ v: 3, type: 'plan_changed' }))).toBeNull()
    })

    it('reads a missing, non-numeric or fractional version as malformed, not as another version', () => {
        expect(readServerMessage(JSON.stringify({ type: 'presence', docId: DOC_ID, envelope: 'AAEC' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage(JSON.stringify({ v: '3', type: 'error' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage(JSON.stringify({ v: 3.5, type: 'error' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage('not json')).toEqual({ kind: 'malformed' })
    })

    it('returns a current-version message without its transport version', () => {
        expect(
            readServerMessage(JSON.stringify({ v: 3, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })),
        ).toEqual({ kind: 'message', message: { type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' } })
    })
})

describe('SyncProtocolMismatchError', () => {
    it('holds both ranges and says which side is older', () => {
        const error = new SyncProtocolMismatchError({ min: 5, max: 6 }, { min: 3, max: 4 })
        expect(error).toMatchObject({ serverRange: { min: 5, max: 6 }, clientRange: { min: 3, max: 4 }, serverVersion: 6, clientVersion: 4, serverIsOlder: false })
        expect(error.message).toContain('sync protocol 5 to 6')
        expect(new SyncProtocolMismatchError(2)).toMatchObject({ serverIsOlder: true, clientRange: { min: 3, max: 3 } })
    })

    it('says which side is older, for logs and the Headless Client', () => {
        const serverOlder = new SyncProtocolMismatchError(1, 2)
        expect(serverOlder.serverIsOlder).toBe(true)
        expect(serverOlder.message).toContain('protocol 1')
        expect(serverOlder.message).toContain('operator needs to upgrade')

        const clientOlder = new SyncProtocolMismatchError(3, 2)
        expect(clientOlder.serverIsOlder).toBe(false)
        expect(clientOlder.message).toContain('this Client is older')
    })
})
