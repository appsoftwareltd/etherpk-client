/**
 * Sealed box: encrypt *to* an X25519 public key so only its holder can open it —
 * how a graph keyring travels to a Player and how the vault key reaches an approved
 * device (ADR 0026). ECIES construction:
 *
 *   ephemeral X25519 pair → ECDH(ephemeral, recipient)
 *   → HKDF-SHA-256(shared, salt = ephPub || recipientPub, info = 'etherpk/sealed/v1')
 *   → AES-256-GCM
 *
 * Layout v1: [0] version=1 | [1] kind=2 | [2..33] ephemeral pub | [34..45] nonce | [46..] ct+tag
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import { concatBytes, randomBytes, utf8 } from './bytes'
import { ENVELOPE_VERSION, EnvelopeError } from './envelope'

export const KIND_SEALED = 2
const HEADER_LENGTH = 46

async function deriveSealKey(
    shared: Uint8Array,
    ephemeralPublic: Uint8Array,
    recipientPublic: Uint8Array,
): Promise<CryptoKey> {
    const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: concatBytes(ephemeralPublic, recipientPublic) as BufferSource,
            info: utf8('etherpk/sealed/v1') as BufferSource,
        },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    )
}

export async function sealToPublicKey(
    recipientPublicKey: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
): Promise<Uint8Array> {
    const ephemeralPrivate = randomBytes(32)
    const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate)
    const shared = x25519.getSharedSecret(ephemeralPrivate, recipientPublicKey)
    const key = await deriveSealKey(shared, ephemeralPublic, recipientPublicKey)
    const nonce = randomBytes(12)
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
            key,
            plaintext as BufferSource,
        ),
    )
    const header = new Uint8Array(HEADER_LENGTH)
    header[0] = ENVELOPE_VERSION
    header[1] = KIND_SEALED
    header.set(ephemeralPublic, 2)
    header.set(nonce, 34)
    return concatBytes(header, ciphertext)
}

export async function openSealed(
    recipientPrivateKey: Uint8Array,
    envelope: Uint8Array,
    aad: Uint8Array,
): Promise<Uint8Array> {
    if (envelope.length < HEADER_LENGTH + 16) throw new EnvelopeError('sealed envelope too short')
    if (envelope[0] !== ENVELOPE_VERSION) throw new EnvelopeError(`unknown envelope version ${envelope[0]}`)
    if (envelope[1] !== KIND_SEALED) throw new EnvelopeError(`unexpected envelope kind ${envelope[1]}`)
    const ephemeralPublic = envelope.subarray(2, 34)
    const shared = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublic)
    const recipientPublic = x25519.getPublicKey(recipientPrivateKey)
    const key = await deriveSealKey(shared, ephemeralPublic, recipientPublic)
    try {
        return new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: envelope.subarray(34, 46) as BufferSource,
                    additionalData: aad as BufferSource,
                },
                key,
                envelope.subarray(HEADER_LENGTH) as BufferSource,
            ),
        )
    } catch {
        throw new EnvelopeError('sealed envelope authentication failed')
    }
}
