/**
 * Proof that this device holds the X25519 private key of the account's Sync Identity (ADR 0126),
 * for the write that gives an identity published before signing keys its first signing key.
 *
 * Such an identity has no signing key to sign with, so the Sync Server offers the account an
 * X25519 key of its own. Both sides reach the same X25519 shared secret, one from each private
 * key, and the proof is an HMAC-SHA-256 over the key write's transcript under a key HKDF-SHA-256
 * derives from that secret (salt: the offered key, then the identity's X25519 key). The proof is
 * good for that one write only, because the transcript names the vault version it replaces.
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { IDENTITY_PROOF_LABEL } from '@appsoftwareltd/etherpk-shared'
import { concatBytes, utf8 } from './bytes'

/**
 * The proof that the holder of `identityPrivateKey` makes for the key write `transcript`
 * describes, against `proofPublicKey`, the key the Sync Server offers the account.
 * @throws when the offered key is one whose shared secret anyone could compute.
 */
export async function identityPossessionProof(
    identityPrivateKey: Uint8Array,
    proofPublicKey: Uint8Array,
    transcript: Uint8Array,
): Promise<Uint8Array> {
    let shared: Uint8Array
    try {
        shared = x25519.getSharedSecret(identityPrivateKey, proofPublicKey)
    } catch {
        throw new Error('the Sync Server offered a key that cannot be used')
    }
    // A low-order key gives the same all-zero secret for every identity, which would prove nothing.
    if (shared.every((b) => b === 0)) throw new Error('the Sync Server offered a key that cannot be used')
    const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveBits'])
    const macKey = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: concatBytes(proofPublicKey, x25519.getPublicKey(identityPrivateKey)) as BufferSource,
            info: utf8(IDENTITY_PROOF_LABEL) as BufferSource,
        },
        ikm,
        256,
    )
    const hmac = await crypto.subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return new Uint8Array(await crypto.subtle.sign('HMAC', hmac, transcript as BufferSource))
}
