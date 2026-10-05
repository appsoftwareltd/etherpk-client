/**
 * The account's signing key pair (Ed25519) and the checks made with it (ADR 0126).
 *
 * A Sync Identity is two key pairs: the X25519 pair that receives sealed keys (identity.ts), and
 * this pair, which signs what the account sends - invites, the Graph Key epochs it hands out, and
 * every write of its vault and published identity - so that a server cannot forge any of them. A
 * signature is checked against the signer's pin when there is one, so keys the server presents for
 * someone the user has not checked are trusted on first use, and comparing Security Fingerprints
 * is what settles them. It is a separate Ed25519 key rather than a signature made with the X25519
 * key (XEdDSA, as Signal does), because no library we use implements XEdDSA and we will not write a
 * signature scheme.
 *
 * Verification follows RFC 8032 strictly (`zip215: false`), which also refuses a public key of
 * small order. The Sync Server verifies with the same library and options, so a signature one side
 * accepts the other accepts too.
 */
import { ed25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { randomBytes } from './bytes'

export interface SigningKeyPair {
    publicKey: Uint8Array
    privateKey: Uint8Array
}

export function generateSigningKeyPair(): SigningKeyPair {
    const privateKey = randomBytes(32)
    return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}

export function signMessage(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
    return ed25519.sign(message, privateKey)
}

/** True only for a good signature. A malformed key or signature is a bad signature, not an error. */
export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    try {
        return ed25519.verify(signature, message, publicKey, { zip215: false })
    } catch {
        return false
    }
}
