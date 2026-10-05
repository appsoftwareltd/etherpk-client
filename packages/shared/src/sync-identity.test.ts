import { describe, expect, it } from 'vitest'
import {
    INVITE_SIGNATURE_LABEL,
    KEY_HANDOUT_SIGNATURE_LABEL,
    KEY_REPLACE_SIGNATURE_LABEL,
    KEY_WRITE_SIGNATURE_LABEL,
    inviteTranscript,
    keyHandoutTranscript,
    keyReplaceTranscript,
    keyWriteTranscript,
} from './sync-identity'

/** Reads a length-prefixed transcript back into its fields. */
function fields(transcript: Uint8Array): Uint8Array[] {
    const view = new DataView(transcript.buffer, transcript.byteOffset, transcript.byteLength)
    const out: Uint8Array[] = []
    let offset = 0
    while (offset < transcript.length) {
        const length = view.getUint32(offset, false)
        out.push(transcript.subarray(offset + 4, offset + 4 + length))
        offset += 4 + length
    }
    return out
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const hash = (fill: number) => new Uint8Array(32).fill(fill)

describe('key write transcript', () => {
    it('holds the label, the account, the version, the vault hash and the identity hash, in order', () => {
        const parts = fields(
            keyWriteTranscript({ principalId: 'account-1', expectedVersion: 7, vaultHash: hash(1), identityHash: hash(2) }),
        )

        expect(parts.map((p, i) => (i < 3 ? text(p) : p))).toEqual([
            KEY_WRITE_SIGNATURE_LABEL,
            'account-1',
            '7',
            hash(1),
            hash(2),
        ])
    })

    it('carries an empty identity field when the write publishes no identity', () => {
        const parts = fields(keyWriteTranscript({ principalId: 'account-1', expectedVersion: 0, vaultHash: hash(1), identityHash: null }))

        expect(parts).toHaveLength(5)
        expect(parts[4]).toHaveLength(0)
    })

    it('differs for another version, so a signature is good for one write only', () => {
        const at = (expectedVersion: number) =>
            keyWriteTranscript({ principalId: 'account-1', expectedVersion, vaultHash: hash(1), identityHash: null })

        expect(at(3)).not.toEqual(at(4))
    })

    it('refuses a version that is not a whole number, so both sides write it the same way', () => {
        expect(() => keyWriteTranscript({ principalId: 'a', expectedVersion: 1.5, vaultHash: hash(1), identityHash: null })).toThrow(
            RangeError,
        )
        expect(() => keyWriteTranscript({ principalId: 'a', expectedVersion: -1, vaultHash: hash(1), identityHash: null })).toThrow(
            RangeError,
        )
    })
})

describe('key replacement transcript (ADR 0128)', () => {
    it('holds its own label, the account, the version, the vault hash and the new identity hash, in order', () => {
        const parts = fields(
            keyReplaceTranscript({ principalId: 'account-1', expectedVersion: 7, vaultHash: hash(1), identityHash: hash(2) }),
        )

        expect(parts.map((p, i) => (i < 3 ? text(p) : p))).toEqual([KEY_REPLACE_SIGNATURE_LABEL, 'account-1', '7', hash(1), hash(2)])
    })

    it('never equals a key write over the same fields, so neither signature passes as the other', () => {
        const same = { principalId: 'account-1', expectedVersion: 7, vaultHash: hash(1), identityHash: hash(2) }

        expect(keyReplaceTranscript(same)).not.toEqual(keyWriteTranscript(same))
    })

    it('refuses a version that is not a whole number above zero: there is a vault to replace', () => {
        expect(() => keyReplaceTranscript({ principalId: 'a', expectedVersion: 0, vaultHash: hash(1), identityHash: hash(2) })).toThrow(RangeError)
        expect(() => keyReplaceTranscript({ principalId: 'a', expectedVersion: 2.5, vaultHash: hash(1), identityHash: hash(2) })).toThrow(RangeError)
    })
})

describe('key hand-out transcript', () => {
    it('holds the label, the graph, the epoch, both accounts, the key sealed to and the copy’s hash, in order', () => {
        const parts = fields(
            keyHandoutTranscript({
                graphId: 'graph-1',
                epoch: 2,
                ownerId: 'owner-1',
                recipientId: 'player-1',
                sealedToPublicKey: hash(5),
                sealedHash: hash(6),
            }),
        )

        expect(parts.map((p, i) => (i < 5 ? text(p) : p))).toEqual([
            KEY_HANDOUT_SIGNATURE_LABEL,
            'graph-1',
            '2',
            'owner-1',
            'player-1',
            hash(5),
            hash(6),
        ])
    })

    it('refuses an epoch that is not a positive whole number', () => {
        const base = { graphId: 'g', ownerId: 'o', recipientId: 'r', sealedToPublicKey: hash(5), sealedHash: hash(6) }

        expect(() => keyHandoutTranscript({ ...base, epoch: 0 })).toThrow(RangeError)
        expect(() => keyHandoutTranscript({ ...base, epoch: 2.5 })).toThrow(RangeError)
    })
})

describe('invite transcript', () => {
    it('holds the label, the graph, both accounts, the invitee identity hash and the payload hash, in order', () => {
        const parts = fields(
            inviteTranscript({
                graphId: 'graph-1',
                inviterId: 'owner-1',
                inviteeId: 'player-1',
                inviteeIdentityHash: hash(3),
                sealedHash: hash(4),
            }),
        )

        expect(parts.map((p, i) => (i < 4 ? text(p) : p))).toEqual([
            INVITE_SIGNATURE_LABEL,
            'graph-1',
            'owner-1',
            'player-1',
            hash(3),
            hash(4),
        ])
    })

    it('changes when bytes move from one field to the next', () => {
        const base = { inviteeIdentityHash: hash(3), sealedHash: hash(4) }

        expect(inviteTranscript({ ...base, graphId: 'ab', inviterId: 'c', inviteeId: 'd' })).not.toEqual(
            inviteTranscript({ ...base, graphId: 'a', inviterId: 'bc', inviteeId: 'd' }),
        )
    })
})
