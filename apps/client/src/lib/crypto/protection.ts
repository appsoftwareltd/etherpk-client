/**
 * The `etherpk-cipher` envelope: a [[Protected Document]]'s ciphertext,
 * as it sits inline in the fence (ADR 0028) — the same bytes on a Filesystem Backend, in an
 * Export, in a Local Mirror, in the Local Cache and on the Sync Server.
 *
 * ADR 0028 requires the envelope be **self-delimiting** and **carry a write timestamp**, because
 * two offline rewrites merge as two intact envelopes concatenated inside one fence and every
 * client must split them and resolve last-write-wins identically, without the key.
 *
 * Layout, version 1 (all multi-byte fields big-endian):
 *
 *   [0]       version = 1                (the envelope family — see envelope.ts)
 *   [1]       kind    = 4                (1 symmetric, 2 sealed, 3 vault, 4 protected)
 *   [2..9]    writtenAt, u64 ms since the epoch
 *   [10..17]  key fingerprint, 8 bytes   (non-secret — see {@link keyFingerprint})
 *   [18..21]  u32 byte length of the inner envelope
 *   [22..]    inner symmetric envelope, sealed under the Protection Key
 *
 * The header is **not** merely a prefix: `writtenAt` and the fingerprint are bound into the inner
 * envelope's AAD. A Player cannot read a protected fence but can still write to the `Y.Text`
 * holding it, so an unauthenticated timestamp would let them bump a stale envelope to win
 * last-write-wins. Editing either field now makes the envelope fail to open.
 *
 * The length prefix is u32, not u16: a Protected Document's whole body is one envelope and a page
 * of notes very easily exceeds 64 KiB.
 */
import { bytesEqual, concatBytes, fromBase64Url, toBase64Url, utf8 } from './bytes'
import { ENVELOPE_VERSION, contextAad, openSymmetric, sealSymmetric } from './envelope'

export const KIND_PROTECTED = 4
/** version + kind + writtenAt + fingerprint + inner length. */
export const PROTECTION_HEADER_LENGTH = 22
export const FINGERPRINT_LENGTH = 8

export class ProtectionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ProtectionError'
    }
}

/**
 * The non-secret fingerprint of a Protection Key. Keys are personal (ADR 0057), so two members of
 * one shared graph hold different keys in it; without the fingerprint a client could not tell
 * *yours, locked* from *another member's, permanently unreadable*, and would offer an unlock
 * prompt no passphrase of yours would satisfy.
 *
 * Truncated to 8 bytes — 64 bits is far past collision range for the handful of keys a graph ever
 * sees, and it keeps the header small enough that a short Protected Document stays small.
 */
export async function keyFingerprint(key: Uint8Array): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        concatBytes(utf8('etherpk:protection-fingerprint:v1'), key) as BufferSource,
    )
    return new Uint8Array(digest).subarray(0, FINGERPRINT_LENGTH)
}

/** AAD binding the inner envelope to the header fields, so neither can be edited in place. */
function protectionAad(writtenAt: number, fingerprint: Uint8Array): Uint8Array {
    return contextAad('protected', String(writtenAt), toBase64Url(fingerprint))
}

function headerView(envelope: Uint8Array): DataView {
    if (envelope.length < PROTECTION_HEADER_LENGTH) throw new ProtectionError('protected envelope too short')
    if (envelope[0] !== ENVELOPE_VERSION) throw new ProtectionError(`unknown envelope version ${envelope[0]}`)
    if (envelope[1] !== KIND_PROTECTED) throw new ProtectionError(`unexpected envelope kind ${envelope[1]}`)
    return new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
}

/** The write timestamp, readable without the key — this is what last-write-wins sorts on. */
export function protectedEnvelopeWrittenAt(envelope: Uint8Array): number {
    return Number(headerView(envelope).getBigUint64(2, false))
}

/** The Protection Key fingerprint, readable without the key. */
export function protectedEnvelopeFingerprint(envelope: Uint8Array): Uint8Array {
    headerView(envelope)
    return envelope.subarray(10, 10 + FINGERPRINT_LENGTH)
}

/** Total byte length of the envelope starting at offset 0, or throws if it is not whole. */
function envelopeLength(envelope: Uint8Array): number {
    const innerLength = headerView(envelope).getUint32(18, false)
    const total = PROTECTION_HEADER_LENGTH + innerLength
    if (envelope.length < total) throw new ProtectionError('protected envelope truncated')
    return total
}

export async function sealProtected(opts: {
    key: Uint8Array
    fingerprint: Uint8Array
    plaintext: string
    writtenAt: number
}): Promise<Uint8Array> {
    const inner = await sealSymmetric({
        key: opts.key,
        epochId: 0,
        plaintext: utf8(opts.plaintext),
        aad: protectionAad(opts.writtenAt, opts.fingerprint),
    })
    const header = new Uint8Array(PROTECTION_HEADER_LENGTH)
    const view = new DataView(header.buffer)
    header[0] = ENVELOPE_VERSION
    header[1] = KIND_PROTECTED
    view.setBigUint64(2, BigInt(opts.writtenAt), false)
    header.set(opts.fingerprint.subarray(0, FINGERPRINT_LENGTH), 10)
    view.setUint32(18, inner.length, false)
    return concatBytes(header, inner)
}

export async function openProtected(opts: {
    key: Uint8Array
    envelope: Uint8Array
}): Promise<{ plaintext: string; writtenAt: number }> {
    const writtenAt = protectedEnvelopeWrittenAt(opts.envelope)
    const fingerprint = protectedEnvelopeFingerprint(opts.envelope)
    const inner = opts.envelope.subarray(PROTECTION_HEADER_LENGTH, envelopeLength(opts.envelope))
    try {
        const { plaintext } = await openSymmetric({
            keyForEpoch: () => opts.key,
            envelope: inner,
            aad: protectionAad(writtenAt, fingerprint),
        })
        return { plaintext: new TextDecoder().decode(plaintext), writtenAt }
    } catch {
        // One message for a wrong key and for a tampered header alike: the caller cannot act on
        // the difference, and distinguishing them would confirm a guessed key to an attacker.
        throw new ProtectionError('protected content could not be opened with this key')
    }
}

/**
 * Split a fence body that holds several envelopes end to end. Yjs never interleaves within one
 * insert, so an offline rewrite on each of two devices merges as two intact envelopes side by
 * side (ADR 0028) — this is what recovers them. Trailing bytes that are not a whole envelope are
 * dropped rather than throwing: a partially-typed or hand-mangled fence must still show the
 * envelopes it does contain.
 */
export function splitProtectedEnvelopes(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []
    let offset = 0
    while (offset < bytes.length) {
        const rest = bytes.subarray(offset)
        let length: number
        try {
            length = envelopeLength(rest)
        } catch {
            break
        }
        out.push(rest.subarray(0, length))
        offset += length
    }
    return out
}

/**
 * ADR 0028's resolution: the newest envelope wins and the losers are discarded. Ties break on the
 * envelope bytes so every client — including one that cannot read any of them — converges on the
 * same winner without coordinating.
 *
 * The losers are genuinely dropped. ADR 0059 records this as an accepted risk: with the projected
 * editing model, two of your own unlocked devices can race, and the loser's work goes with it.
 */
export function resolveLastWriteWins(envelopes: readonly Uint8Array[]): Uint8Array | null {
    let winner: Uint8Array | null = null
    let winnerAt = -1
    for (const envelope of envelopes) {
        let writtenAt: number
        try {
            writtenAt = protectedEnvelopeWrittenAt(envelope)
        } catch {
            continue
        }
        if (writtenAt > winnerAt || (writtenAt === winnerAt && winner && compareBytes(envelope, winner) > 0)) {
            winner = envelope
            winnerAt = writtenAt
        }
    }
    return winner
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    if (bytesEqual(a, b)) return 0
    const shared = Math.min(a.length, b.length)
    for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return a.length < b.length ? -1 : 1
}

/**
 * Armour an envelope for the fence body. base64url has no backtick, so armoured content can never
 * be mistaken for a closing fence, and no newline, so one envelope is one line — which keeps a
 * Filesystem Backend graph's git diffs to a single changed line per write.
 */
export function armourProtected(envelope: Uint8Array): string {
    return toBase64Url(envelope)
}

/**
 * Read every envelope out of a fence body. Handles both shapes a merge can produce: one envelope
 * per line (the normal case), and several concatenated within one line. Blank and undecodable
 * lines are skipped — a hand-edited fence must still yield what it holds.
 */
export function unarmourProtected(body: string): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            out.push(...splitProtectedEnvelopes(fromBase64Url(trimmed)))
        } catch {
            continue
        }
    }
    return out
}
