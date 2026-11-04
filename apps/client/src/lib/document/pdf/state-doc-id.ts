/**
 * The document id of a person's private document for one PDF: derived as a [[Journal Entry]]'s is
 * (`journal-doc-id.ts`, ADR 0157), so each of their devices reaches the same document with nothing
 * stored in the root document to find it by. The id comes from the epoch 1 key, so it does not
 * change when the graph moves to a new Graph Key epoch. Without the key an id looks random, so the
 * server learns neither the person nor the PDF from it.
 *
 *   secret = HKDF-SHA-256(ikm = epoch 1 key, salt = graph id, info = 'etherpk/pdf-state-doc-id/v1')
 *   id     = HMAC-SHA-256(secret, '<member>:<hash>'), first 128 bits, as a version 8 UUID
 */
import { utf8 } from '#lib/crypto/bytes.js'
import { keyForEpoch, type GraphKeyring } from '#lib/crypto/keyring.js'

const INFO = 'etherpk/pdf-state-doc-id/v1'

export async function derivePdfStateIdSecret(keyring: GraphKeyring): Promise<Uint8Array> {
    const first = keyForEpoch(keyring, 1)
    if (!first) throw new Error('derivePdfStateIdSecret: keyring has no epoch 1 key')
    const ikm = await crypto.subtle.importKey('raw', first as BufferSource, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(keyring.graphId) as BufferSource, info: utf8(INFO) as BufferSource },
        ikm,
        256,
    )
    return new Uint8Array(bits)
}

export async function pdfStateDocId(secret: Uint8Array, member: string, hash: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${member}:${hash}`) as BufferSource)).slice(0, 16)
    // RFC 9562 version 8 with the RFC variant: the sync protocol validates document ids as UUIDs.
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
