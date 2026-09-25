import { describe, expect, it } from 'vitest'
import { SyncProtocolMismatchError, parseServerMessage, readServerMessage, serializeClientMessage } from './messages'

const DOC_ID = '018f47a0-7b5d-7cc5-b5c1-f0fbcde11234'

describe('client sync protocol boundary', () => {
    it('adds protocol v2 to outbound messages', () => {
        expect(JSON.parse(serializeClientMessage({ type: 'subscribe', docIds: [DOC_ID] }))).toEqual({
            v: 2,
            type: 'subscribe',
            docIds: [DOC_ID],
        })
    })

    it('accepts shared v2 server messages and removes the transport version', () => {
        expect(
            parseServerMessage(JSON.stringify({ v: 2, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })),
        ).toEqual({ type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })
    })

    it('rejects unversioned and malformed messages through the shared parser', () => {
        expect(parseServerMessage(JSON.stringify({ type: 'presence', docId: DOC_ID, envelope: 'AAEC' }))).toBeNull()
        expect(parseServerMessage('not json')).toBeNull()
    })

    it('names the server protocol version when a message carries a different numeric version', () => {
        // The server answers a mismatch with an error in its OWN version, so the Client reads
        // "their version is not mine" in both directions.
        expect(readServerMessage(JSON.stringify({ v: 3, type: 'error', code: 'unsupported_version' }))).toEqual({
            kind: 'protocol_mismatch',
            serverVersion: 3,
        })
        expect(readServerMessage(JSON.stringify({ v: 1, type: 'ack', outboxId: 'x' }))).toEqual({
            kind: 'protocol_mismatch',
            serverVersion: 1,
        })
    })

    it('reads a missing, non-numeric or fractional version as malformed, not as a mismatch', () => {
        expect(readServerMessage(JSON.stringify({ type: 'presence', docId: DOC_ID, envelope: 'AAEC' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage(JSON.stringify({ v: '3', type: 'error' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage(JSON.stringify({ v: 2.5, type: 'error' }))).toEqual({ kind: 'malformed' })
        expect(readServerMessage('not json')).toEqual({ kind: 'malformed' })
    })

    it('returns a current-version message without its transport version', () => {
        expect(
            readServerMessage(JSON.stringify({ v: 2, type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' })),
        ).toEqual({ kind: 'message', message: { type: 'update', docId: DOC_ID, generation: 1, seq: 3, epochId: 1, envelope: 'AAEC' } })
    })
})

describe('SyncProtocolMismatchError', () => {
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
