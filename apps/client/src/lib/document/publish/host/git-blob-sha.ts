/**
 * The name git gives a file's content: the SHA-1 of `blob <byte length>\0` followed by the bytes,
 * as `git hash-object` prints it. A [[Publish Repository]] compares it with the names in the
 * branch's tree to find what a publish changed without downloading a single file, and an
 * unchanged image keeps its name, so a later publish never sends it again.
 *
 * WebCrypto, which the browser and Node both have, so the Client and the Headless Client share it.
 * SHA-1 here is git's object name, not a security measure.
 */

const encoder = new TextEncoder()

export async function gitBlobSha(content: string | Uint8Array): Promise<string> {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content
    const header = encoder.encode(`blob ${bytes.byteLength}\0`)
    const object = new Uint8Array(header.byteLength + bytes.byteLength)
    object.set(header, 0)
    object.set(bytes, header.byteLength)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object))
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
