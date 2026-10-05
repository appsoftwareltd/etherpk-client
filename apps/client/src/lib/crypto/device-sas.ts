/**
 * The cryptography of Device Approval (ADR 0125, which amends ADR 0034).
 *
 * Both devices contribute a one-time X25519 key, and commit-then-reveal stops either side's
 * contribution being chosen after seeing the other's:
 *
 * 1. The new device posts only `commitment = SHA-256(label || requesterPublicKey)`.
 * 2. An approving device answers with its own one-time public key.
 * 3. Only then does the new device reveal its public key, which the approving device checks
 *    against the commitment.
 * 4. Both hash the whole exchange into a transcript and show its first 40 bits as an 8-character
 *    code. A server that substitutes a key has to fix the substitute before it learns what the code
 *    depends on, so it matches with probability 1 in 2^40 per attempt.
 *
 * The vault key then travels encrypted under a key derived from the two one-time keys and the
 * transcript, so only those two devices can open the reply and the server cannot forge one.
 *
 * The approving device must use the key pair it generated itself for every step. Taking a value
 * the server supplied would let the server choose it after the reveal and search for a match.
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { bytesEqual, concatBytes, lengthPrefixed, utf8 } from './bytes'
import { sha256 } from './digest'
import { contextAad, openSymmetric, sealSymmetric } from './envelope'
import { encodeCrockford32 } from './recovery-code'

/** Must equal the label the Sync Server checks a reveal against (`@appsoftwareltd/etherpk-shared`). */
export const DEVICE_APPROVAL_COMMIT_LABEL = 'etherpk/device-approval/commit/v2'
const TRANSCRIPT_LABEL = 'etherpk/device-approval/transcript/v2'
const REPLY_INFO = 'etherpk/device-approval/reply/v2'

/** What the new device posts in place of its public key: a hash that binds it to that key. */
export function approvalCommitment(requesterPublicKey: Uint8Array): Promise<Uint8Array> {
    return sha256(concatBytes(utf8(DEVICE_APPROVAL_COMMIT_LABEL), requesterPublicKey))
}

/** Does the revealed key match the commitment the new device posted first? */
export async function commitmentMatches(commitment: Uint8Array, requesterPublicKey: Uint8Array): Promise<boolean> {
    return bytesEqual(commitment, await approvalCommitment(requesterPublicKey))
}

/**
 * The hash of the whole exchange, from which both screens derive the code and both devices derive
 * the reply key. Length-prefixed, so no field can borrow bytes from its neighbour.
 */
export function approvalTranscript(exchange: {
    approvalId: string
    commitment: Uint8Array
    approverPublicKey: Uint8Array
    requesterPublicKey: Uint8Array
}): Promise<Uint8Array> {
    return sha256(
        lengthPrefixed(
            utf8(TRANSCRIPT_LABEL),
            utf8(exchange.approvalId),
            exchange.commitment,
            exchange.approverPublicKey,
            exchange.requesterPublicKey,
        ),
    )
}

/** The code both screens show, e.g. "7Q4M-KX2A": the transcript's first 40 bits in Crockford base32. */
export function approvalCode(transcript: Uint8Array): string {
    const code = encodeCrockford32(transcript.subarray(0, 5))
    return `${code.slice(0, 4)}-${code.slice(4, 8)}`
}

/**
 * The key the vault key travels under: HKDF-SHA-256 over the X25519 shared secret of this device's
 * one-time private key and the other device's one-time public key, salted with the transcript.
 * A shared secret of all zeros means the peer key was a low-order point, which would let anyone
 * compute the key, so it is refused.
 */
export async function approvalReplyKey(privateKey: Uint8Array, peerPublicKey: Uint8Array, transcript: Uint8Array): Promise<Uint8Array> {
    let shared: Uint8Array
    try {
        shared = x25519.getSharedSecret(privateKey, peerPublicKey)
    } catch {
        throw new Error('the other device sent a key that cannot be used')
    }
    if (shared.every((b) => b === 0)) throw new Error('the other device sent a key that cannot be used')
    const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: transcript as BufferSource, info: utf8(REPLY_INFO) as BufferSource },
        ikm,
        256,
    )
    return new Uint8Array(bits)
}

function replyAad(approvalId: string): Uint8Array {
    return contextAad('device-approval', 'v2', `approval:${approvalId}`)
}

/** The approving device encrypts the vault key for the requesting device. */
export function sealApprovalReply(replyKey: Uint8Array, vaultKey: Uint8Array, approvalId: string): Promise<Uint8Array> {
    return sealSymmetric({ key: replyKey, epochId: 0, plaintext: vaultKey, aad: replyAad(approvalId) })
}

/** The requesting device opens the reply. Rejects for a reply sealed under any other key or request. */
export async function openApprovalReply(replyKey: Uint8Array, reply: Uint8Array, approvalId: string): Promise<Uint8Array> {
    return (await openSymmetric({ keyForEpoch: () => replyKey, envelope: reply, aad: replyAad(approvalId) })).plaintext
}
