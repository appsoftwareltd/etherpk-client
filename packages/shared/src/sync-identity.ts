/**
 * The parts of signed Sync Identities (ADR 0126) that the Client and the Sync Server must build
 * byte for byte the same way.
 *
 * A Sync Identity is an X25519 key pair, which receives sealed keys, and an Ed25519 key pair,
 * which signs what the account sends. The Client signs these transcripts. The Sync Server checks
 * a key write's signature against the signing key it has on record for the account, and an
 * invite's signature against the inviter's, so a sign-in alone cannot replace an account's keys or
 * send an invite in its name. The Client checks invites itself as well, since it does not
 * trust the server to.
 *
 * Each field is preceded by its length as a 32-bit big-endian integer, so bytes cannot move from
 * one field to the next and leave the transcript the same. Each transcript starts with its own
 * label, so a signature over one kind of transcript can never pass as another.
 */

/** Hashed with the X25519 key, then the Ed25519 key, into the identity hash and the Security Fingerprint. */
export const IDENTITY_FINGERPRINT_LABEL = 'etherpk/identity-fingerprint/v2'

/** Starts the transcript a vault write (and an identity publish with it) is signed over. */
export const KEY_WRITE_SIGNATURE_LABEL = 'etherpk/key-write/v1'

/** Starts the transcript an invite is signed over. */
export const INVITE_SIGNATURE_LABEL = 'etherpk/invite/v1'

/** Starts the transcript each copy of a new Graph Key epoch is signed over (ADR 0127). */
export const KEY_HANDOUT_SIGNATURE_LABEL = 'etherpk/key-handout/v1'

/** Starts the transcript a Key Replacement is signed over, by the old signing key and the new (ADR 0128). */
export const KEY_REPLACE_SIGNATURE_LABEL = 'etherpk/key-replace/v1'

/** The coded refusal for a key write whose signature the signing key on record does not accept. */
export const KEY_SIGNATURE_REFUSED_CODE = 'key_signature_refused'

/**
 * HKDF info for the key an identity proof is made under. The write that gives an identity
 * published before signing keys its first signing key must prove that its author holds that
 * identity's X25519 private key: X25519 between that key and a key the Sync Server offers the
 * account, HKDF-SHA-256 over the shared secret (salt: the offered key, then the identity's X25519
 * key), and HMAC-SHA-256 over the key write's transcript.
 */
export const IDENTITY_PROOF_LABEL = 'etherpk/identity-proof/v1'

/** The coded refusal for a key write that gives such an identity a signing key without that proof. */
export const IDENTITY_PROOF_REFUSED_CODE = 'identity_proof_refused'

const utf8 = (text: string) => new TextEncoder().encode(text)

function lengthPrefixed(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0))
    const view = new DataView(out.buffer)
    let offset = 0
    for (const p of parts) {
        view.setUint32(offset, p.length, false)
        out.set(p, offset + 4)
        offset += 4 + p.length
    }
    return out
}

/**
 * What a key write is signed over: the account, the vault version the write replaces, the
 * SHA-256 of the new vault envelope, and the identity hash of the identity published with it
 * (empty when the write publishes none). The version makes each signature good for one write
 * only: once it lands the version moves on, so a captured request cannot be sent again.
 */
export function keyWriteTranscript(fields: {
    principalId: string
    expectedVersion: number
    vaultHash: Uint8Array
    identityHash: Uint8Array | null
}): Uint8Array {
    if (!Number.isSafeInteger(fields.expectedVersion) || fields.expectedVersion < 0) {
        throw new RangeError(`expectedVersion must be a whole number, not ${fields.expectedVersion}`)
    }
    return lengthPrefixed(
        utf8(KEY_WRITE_SIGNATURE_LABEL),
        utf8(fields.principalId),
        utf8(String(fields.expectedVersion)),
        fields.vaultHash,
        fields.identityHash ?? new Uint8Array(0),
    )
}

/**
 * What a Key Replacement is signed over (ADR 0128): the account, the vault version it replaces,
 * the SHA-256 of the vault under its new vault key, and the identity hash of the new identity. The
 * signing key on record signs it, which only a device holding the current keys can do, and the
 * new signing key signs it too, which proves the account holds the key it registers. Its own label
 * keeps a replacement and an ordinary key write from passing as each other.
 */
export function keyReplaceTranscript(fields: {
    principalId: string
    expectedVersion: number
    vaultHash: Uint8Array
    identityHash: Uint8Array
}): Uint8Array {
    if (!Number.isSafeInteger(fields.expectedVersion) || fields.expectedVersion < 1) {
        throw new RangeError(`expectedVersion must be a positive whole number, not ${fields.expectedVersion}`)
    }
    return lengthPrefixed(
        utf8(KEY_REPLACE_SIGNATURE_LABEL),
        utf8(fields.principalId),
        utf8(String(fields.expectedVersion)),
        fields.vaultHash,
        fields.identityHash,
    )
}

/**
 * What the owner signs each copy of a new Graph Key epoch over (ADR 0127): the graph, the epoch,
 * the owner's and the recipient's account ids, the X25519 key the copy was sealed to, and the
 * SHA-256 of the sealed copy. It names the X25519 key rather than the identity hash because a
 * member whose EtherPK has not opened their keys since signing keys existed has no signing key
 * yet, and still needs the new key.
 */
export function keyHandoutTranscript(fields: {
    graphId: string
    epoch: number
    ownerId: string
    recipientId: string
    sealedToPublicKey: Uint8Array
    sealedHash: Uint8Array
}): Uint8Array {
    if (!Number.isSafeInteger(fields.epoch) || fields.epoch < 1) {
        throw new RangeError(`epoch must be a positive whole number, not ${fields.epoch}`)
    }
    return lengthPrefixed(
        utf8(KEY_HANDOUT_SIGNATURE_LABEL),
        utf8(fields.graphId),
        utf8(String(fields.epoch)),
        utf8(fields.ownerId),
        utf8(fields.recipientId),
        fields.sealedToPublicKey,
        fields.sealedHash,
    )
}

/**
 * What an invite is signed over: the graph, the inviter's and the invitee's account ids, the
 * identity hash of the invitee identity the keys were sealed to, and the SHA-256 of the sealed
 * payload. A server can then neither invent an invite nor move a real one to another graph,
 * person or payload.
 */
export function inviteTranscript(fields: {
    graphId: string
    inviterId: string
    inviteeId: string
    inviteeIdentityHash: Uint8Array
    sealedHash: Uint8Array
}): Uint8Array {
    return lengthPrefixed(
        utf8(INVITE_SIGNATURE_LABEL),
        utf8(fields.graphId),
        utf8(fields.inviterId),
        utf8(fields.inviteeId),
        fields.inviteeIdentityHash,
        fields.sealedHash,
    )
}
