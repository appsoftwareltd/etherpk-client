/** SHA-256 of `bytes`: what transcripts, commitments and signed writes name their contents by. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** SHA-256 of `bytes` as lower-case hex: what a reader keeps a person's annotations under. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    return [...(await sha256(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
