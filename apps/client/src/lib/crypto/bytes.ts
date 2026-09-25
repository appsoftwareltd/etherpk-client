/**
 * Byte-array and encoding primitives for the crypto core. No cryptography here.
 * lib/crypto must stay self-contained (no imports from outside lib/crypto).
 */
export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

/** Constant-time-shaped comparison (length leak is fine; contents don't short-circuit). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
}

export function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    crypto.getRandomValues(out)
    return out
}

export function toBase64Url(bytes: Uint8Array): string {
    let raw = ''
    for (const b of bytes) raw += String.fromCharCode(b)
    return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
    const raw = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
}
