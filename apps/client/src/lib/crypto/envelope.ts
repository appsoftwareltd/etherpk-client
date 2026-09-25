/**
 * The one binary envelope for symmetric (epoch-keyed) content — updates, snapshots,
 * the vault, asset chunks. Self-delimiting layout, version 1:
 *
 *   [0]      version = 1
 *   [1]      kind    = 1 (symmetric; sealed boxes are kind 2 — sealed.ts)
 *   [2..5]   epochId, u32 little-endian (0 where epochs don't apply, e.g. the vault)
 *   [6..17]  AES-GCM nonce (12 bytes, fresh random per seal)
 *   [18..]   ciphertext + GCM tag
 *
 * AAD binds the envelope to its context — (graph, doc, kind) — so a compromised server
 * cannot splice a valid blob into another document (design doc → Cryptography).
 */
import { concatBytes, randomBytes, utf8 } from './bytes'

export const ENVELOPE_VERSION = 1
export const KIND_SYMMETRIC = 1
const HEADER_LENGTH = 18

export class EnvelopeError extends Error {}

/** Canonical AAD builder: contextAad('update', 'graph:<id>', 'doc:<id>'). */
export function contextAad(...parts: string[]): Uint8Array {
    return utf8(`etherpk:v1|${parts.join('|')}`)
}

async function importAesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [usage])
}

export async function sealSymmetric(opts: {
    key: Uint8Array
    epochId: number
    plaintext: Uint8Array
    aad: Uint8Array
}): Promise<Uint8Array> {
    const nonce = randomBytes(12)
    const aesKey = await importAesKey(opts.key, 'encrypt')
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            // TS 6 + DOM lib: algorithm byte fields need BufferSource casts too, or check fails
            { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: opts.aad as BufferSource },
            aesKey,
            opts.plaintext as BufferSource,
        ),
    )
    const header = new Uint8Array(HEADER_LENGTH)
    header[0] = ENVELOPE_VERSION
    header[1] = KIND_SYMMETRIC
    new DataView(header.buffer).setUint32(2, opts.epochId, true)
    header.set(nonce, 6)
    return concatBytes(header, ciphertext)
}

/** Read the epoch id without decrypting (the client picks the keyring entry from it). */
export function envelopeEpochId(envelope: Uint8Array): number {
    if (envelope.length < HEADER_LENGTH) throw new EnvelopeError('envelope too short')
    if (envelope[0] !== ENVELOPE_VERSION) throw new EnvelopeError(`unknown envelope version ${envelope[0]}`)
    if (envelope[1] !== KIND_SYMMETRIC) throw new EnvelopeError(`unexpected envelope kind ${envelope[1]}`)
    return new DataView(envelope.buffer, envelope.byteOffset).getUint32(2, true)
}

export async function openSymmetric(opts: {
    keyForEpoch: (epochId: number) => Uint8Array | undefined
    envelope: Uint8Array
    aad: Uint8Array
}): Promise<{ plaintext: Uint8Array; epochId: number }> {
    const epochId = envelopeEpochId(opts.envelope)
    const key = opts.keyForEpoch(epochId)
    if (!key) throw new EnvelopeError(`no key for epoch ${epochId}`)
    const aesKey = await importAesKey(key, 'decrypt')
    try {
        const plaintext = new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: opts.envelope.subarray(6, 18) as BufferSource,
                    additionalData: opts.aad as BufferSource,
                },
                aesKey,
                opts.envelope.subarray(HEADER_LENGTH) as BufferSource,
            ),
        )
        return { plaintext, epochId }
    } catch {
        throw new EnvelopeError('envelope authentication failed')
    }
}
