/**
 * The account identity keypair (X25519) and its display fingerprint (ADR 0026).
 * @noble/curves is pure JS (no WASM) and clamps private scalars internally.
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { randomBytes } from './bytes'

export interface IdentityKeyPair {
    publicKey: Uint8Array
    privateKey: Uint8Array
}

export function generateIdentityKeyPair(): IdentityKeyPair {
    const privateKey = randomBytes(32)
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

/**
 * SHA-256 of the public key, first 128 bits as 8 groups of 4 hex chars —
 * the out-of-band verification string two users compare (ADR 0026, TOFU).
 */
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey as BufferSource))
    const hex = [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex.toUpperCase().match(/.{4}/g)!.join(' ')
}
