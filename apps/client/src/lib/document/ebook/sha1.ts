/**
 * SHA-1, for the one thing an EBook needs it for: EPUB's font obfuscation derives its key from the EBook's
 * identifier with it. It is not protecting anything. The frame an EBook reads in has no secure context,
 * so it has no `crypto.subtle` to ask (ADR 0181).
 */
const rotate = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits))

function padded(message: Uint8Array): DataView {
    const length = ((message.length + 8) >> 6) * 64 + 64
    const bytes = new Uint8Array(length)
    bytes.set(message)
    bytes[message.length] = 0x80
    const view = new DataView(bytes.buffer)
    view.setUint32(length - 8, Math.floor((message.length * 8) / 2 ** 32))
    view.setUint32(length - 4, (message.length * 8) >>> 0)
    return view
}

function round(step: number, b: number, c: number, d: number): number {
    if (step < 20) return ((b & c) | (~b & d)) + 0x5a827999
    if (step < 40) return (b ^ c ^ d) + 0x6ed9eba1
    if (step < 60) return ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc
    return (b ^ c ^ d) + 0xca62c1d6
}

export function sha1(text: string): Uint8Array {
    const view = padded(new TextEncoder().encode(text))
    const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
    const words = new Int32Array(80)
    for (let offset = 0; offset < view.byteLength; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4)
        for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1)
        let [a, b, c, d, e] = state
        for (let step = 0; step < 80; step++) {
            const next = (rotate(a, 5) + round(step, b, c, d) + e + words[step]) | 0
            e = d
            d = c
            c = rotate(b, 30)
            b = a
            a = next
        }
        ;[a, b, c, d, e].forEach((value, i) => (state[i] = (state[i] + value) | 0))
    }
    const out = new DataView(new ArrayBuffer(20))
    state.forEach((value, i) => out.setInt32(i * 4, value))
    return new Uint8Array(out.buffer)
}
