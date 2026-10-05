/** SHA-256 of `bytes`: what transcripts, commitments and signed writes name their contents by. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}
