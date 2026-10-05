/**
 * The header of EtherPK's symmetric envelope, which carries document updates, snapshots,
 * presence, the vault and asset chunks. The Client seals it (`crypto/envelope.ts`):
 *
 *   [0]      version = 1
 *   [1]      kind    = 1 (symmetric; sealed boxes are kind 2)
 *   [2..5]   epoch id, an unsigned 32-bit LITTLE-endian integer (0 where epochs do not apply)
 *   [6..17]  AES-GCM nonce
 *   [18..]   ciphertext and tag
 *
 * The epoch is little-endian, unlike the big-endian length prefixes of the signed transcripts in
 * sync-identity.ts. The header is not encrypted, so the Sync Server can read which Graph Key
 * epoch a write was sealed under without being able to open it, and refuse a write labelled with
 * another (ADR 0127).
 */

export const ENVELOPE_VERSION = 1
export const ENVELOPE_KIND_SYMMETRIC = 1
export const SYMMETRIC_ENVELOPE_HEADER_LENGTH = 18

/** The base64url characters that hold exactly the header: 18 bytes are 24 characters. */
export const SYMMETRIC_ENVELOPE_HEADER_BASE64URL_LENGTH = 24

const NONCE_LENGTH = 12
const MAX_EPOCH_ID = 0xffff_ffff

export type SymmetricEnvelopeHeader =
    | { ok: true; epochId: number }
    | { ok: false; problem: 'too-short' | 'unknown-version' | 'not-symmetric' }

/** Read the header of `envelope`, or say why the bytes are not a symmetric envelope. */
export function readSymmetricEnvelopeHeader(envelope: Uint8Array): SymmetricEnvelopeHeader {
    if (envelope.length < SYMMETRIC_ENVELOPE_HEADER_LENGTH) return { ok: false, problem: 'too-short' }
    if (envelope[0] !== ENVELOPE_VERSION) return { ok: false, problem: 'unknown-version' }
    if (envelope[1] !== ENVELOPE_KIND_SYMMETRIC) return { ok: false, problem: 'not-symmetric' }
    // The view starts at the array's own offset: a Node Buffer often shares a larger pool.
    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
    return { ok: true, epochId: view.getUint32(2, true) }
}

/** The header of an envelope sealed under `epochId` with the AES-GCM `nonce`. */
export function symmetricEnvelopeHeader(epochId: number, nonce: Uint8Array): Uint8Array {
    if (!Number.isInteger(epochId) || epochId < 0 || epochId > MAX_EPOCH_ID) {
        throw new RangeError(`epochId must fit an unsigned 32-bit integer, not ${epochId}`)
    }
    if (nonce.length !== NONCE_LENGTH) throw new RangeError(`the AES-GCM nonce must be ${NONCE_LENGTH} bytes`)
    const header = new Uint8Array(SYMMETRIC_ENVELOPE_HEADER_LENGTH)
    header[0] = ENVELOPE_VERSION
    header[1] = ENVELOPE_KIND_SYMMETRIC
    new DataView(header.buffer).setUint32(2, epochId, true)
    header.set(nonce, 6)
    return header
}
