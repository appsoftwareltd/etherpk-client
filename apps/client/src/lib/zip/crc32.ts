/**
 * CRC-32 (IEEE 802.3), the checksum every zip entry carries. `fflate` computes one internally
 * for its own archives and does not export it, and a zip64 writer needs it for every entry's
 * local header before the data goes out.
 */

const TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

/** The CRC-32 of `bytes`, continuing from `seed` when a caller checksums in pieces. */
export function crc32(bytes: Uint8Array, seed = 0): number {
    let c = (seed ^ 0xffffffff) >>> 0
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}
