/**
 * The Recovery Code (ADR 0026): 128 bits of generated entropy the user saves once.
 * Crockford base32 (no I, L, O, U) so it survives handwriting and re-typing;
 * normalization maps the confusables back. HKDF only — the code is high-entropy,
 * so no password-hardening KDF is needed anywhere in the system.
 */
import { randomBytes, utf8 } from './bytes'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PREFIX = 'EPK1'
const BODY_LENGTH = 26 // 16 bytes → ceil(128/5) = 26 base32 chars

export class RecoveryCodeError extends Error {}

/** e.g. EPK1-4R9TN-0WXA2-JH6MK-P3VZE-C58DQF */
export function generateRecoveryCode(): string {
    return formatKit(encodeBase32(randomBytes(16)))
}

function formatKit(body: string): string {
    return `${PREFIX}-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}-${body.slice(20)}`
}

/** Crockford base32 (no I, L, O, U) — shared with the device-approval SAS, which is
 *  human-compared across two screens and needs the same confusable-resistance. */
export function encodeCrockford32(bytes: Uint8Array): string {
    return encodeBase32(bytes)
}

function encodeBase32(bytes: Uint8Array): string {
    let bits = 0
    let value = 0
    let out = ''
    for (const b of bytes) {
        value = (value << 8) | b
        bits += 8
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
    return out
}

function decodeBase32(chars: string): Uint8Array {
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const c of chars) {
        const index = ALPHABET.indexOf(c)
        if (index < 0) throw new RecoveryCodeError(`invalid recovery code character "${c}"`)
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return new Uint8Array(out)
}

/** Uppercase, strip spaces/dashes, map O→0 and I/L→1, verify prefix + length; return canonical form. */
export function normalizeRecoveryCode(input: string): string {
    const cleaned = input
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replaceAll('O', '0')
        .replaceAll('I', '1')
        .replaceAll('L', '1')
    if (!cleaned.startsWith(PREFIX)) throw new RecoveryCodeError('not a Recovery Code (missing EPK1 prefix)')
    const body = cleaned.slice(PREFIX.length)
    if (body.length !== BODY_LENGTH) {
        throw new RecoveryCodeError(`expected ${BODY_LENGTH} characters after the prefix, got ${body.length}`)
    }
    return formatKit(body)
}

export function recoveryCodeToBytes(code: string): Uint8Array {
    const body = normalizeRecoveryCode(code).slice(PREFIX.length + 1).replaceAll('-', '')
    return decodeBase32(body)
}

/** The vault wrap key: HKDF-SHA-256 over the code's bytes. */
export async function deriveVaultWrapKey(code: string): Promise<Uint8Array> {
    const ikm = await crypto.subtle.importKey('raw', recoveryCodeToBytes(code) as BufferSource, 'HKDF', false, [
        'deriveBits',
    ])
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: utf8('etherpk-vault-v1') as BufferSource,
            info: utf8('vault-wrap') as BufferSource,
        },
        ikm,
        256,
    )
    return new Uint8Array(bits)
}
