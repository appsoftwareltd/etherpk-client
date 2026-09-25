/**
 * The device-approval SAS (Short Authentication String): a short code both devices derive
 * from the requesting device's ephemeral public key and display for the user to compare.
 * The server brokers that key, so a malicious server could substitute its own — but then
 * the two screens derive DIFFERENT codes and the user refuses. One shot: a mismatch means
 * starting over with a fresh key, so 40 displayed bits leave no room to search for a
 * matching substitute. Same trust move as the invite fingerprint (identity.ts).
 */
import { concatBytes, utf8 } from './bytes'
import { encodeCrockford32 } from './recovery-code'

const SAS_CONTEXT = utf8('etherpk/device-approval-sas/v1')

/** e.g. "7Q4M-KX2A" — first 40 bits of SHA-256(context || ephemeral public key). */
export async function deviceApprovalSas(ephemeralPublicKey: Uint8Array): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', concatBytes(SAS_CONTEXT, ephemeralPublicKey) as BufferSource),
    )
    const code = encodeCrockford32(digest.subarray(0, 5))
    return `${code.slice(0, 4)}-${code.slice(4, 8)}`
}
