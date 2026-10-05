/**
 * The account's Sync Identity (ADR 0026, amended by ADR 0126): an X25519 key pair that receives
 * sealed keys, and an Ed25519 key pair (signing.ts) that signs what the account sends. The Sync
 * Server publishes the two public keys, and the Security Fingerprint covers both.
 * @noble/curves is pure JS (no WASM) and clamps private scalars internally.
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { bytesEqual, concatBytes, randomBytes, utf8 } from './bytes'

export interface IdentityKeyPair {
    publicKey: Uint8Array
    privateKey: Uint8Array
}

export function generateIdentityKeyPair(): IdentityKeyPair {
    const privateKey = randomBytes(32)
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

/** The public half of a Sync Identity, as the Sync Server publishes it and a pin keeps it. */
export interface PublicIdentity {
    /** X25519: what invites and Graph Key epochs are sealed to. */
    publicKey: Uint8Array
    /** Ed25519: what the account's signatures are checked with. */
    signingPublicKey: Uint8Array
}

/**
 * The same label as the shared package's `IDENTITY_FINGERPRINT_LABEL`, which the Sync Server
 * hashes key writes with (identity.test.ts holds them equal): lib/crypto imports nothing from
 * outside itself.
 */
export const IDENTITY_FINGERPRINT_LABEL = 'etherpk/identity-fingerprint/v2'

const KEY_LENGTH = 32

/**
 * SHA-256(label || X25519 public key || Ed25519 public key): the name signatures give an identity
 * (an invite names the identity it was sealed to), and the source of the Security Fingerprint. Both
 * keys are always 32 bytes, which is what keeps the plain concatenation unambiguous.
 */
export async function identityHash(identity: PublicIdentity): Promise<Uint8Array> {
    if (identity.publicKey.length !== KEY_LENGTH || identity.signingPublicKey.length !== KEY_LENGTH) {
        throw new RangeError('an identity is two 32-byte public keys')
    }
    const input = concatBytes(utf8(IDENTITY_FINGERPRINT_LABEL), identity.publicKey, identity.signingPublicKey)
    return new Uint8Array(await crypto.subtle.digest('SHA-256', input as BufferSource))
}

/** The first 128 bits of an identity hash, as 8 groups of 4 upper-case hex characters. */
export function formatFingerprint(hash: Uint8Array): string {
    const hex = [...hash.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex.toUpperCase().match(/.{4}/g)!.join(' ')
}

/**
 * The Security Fingerprint: the string two people compare, in person or over a call they trust,
 * before one shares a graph with the other (ADR 0026, ADR 0126). It covers both public keys, so a
 * server cannot keep the fingerprint and swap the signing key.
 */
export async function fingerprint(identity: PublicIdentity): Promise<string> {
    return formatFingerprint(await identityHash(identity))
}

export function samePublicIdentity(a: PublicIdentity, b: PublicIdentity): boolean {
    return bytesEqual(a.publicKey, b.publicKey) && bytesEqual(a.signingPublicKey, b.signingPublicKey)
}

/**
 * The public half of the identity a vault holds, or null for a vault written before signing keys
 * existed. The next unlock adds one (`ensureAccountIdentity`), and until then the account has no
 * Security Fingerprint and cannot send an invite.
 */
export function identityPublicKeys(vault: {
    identityPublicKey: Uint8Array
    signingPublicKey?: Uint8Array
}): PublicIdentity | null {
    return vault.signingPublicKey ? { publicKey: vault.identityPublicKey, signingPublicKey: vault.signingPublicKey } : null
}
