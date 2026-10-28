/**
 * The **journal document id** (ADR 0157): a [[Journal Entry]]'s document id, derived from its day,
 * so two devices that start the same day before they hear of each other write into one document
 * and the CRDT merges their text, instead of leaving two documents behind one name.
 *
 *   secret = HKDF-SHA-256(ikm = epoch 1 key, salt = graph id, info = 'etherpk/journal-doc-id/v1')
 *   id     = HMAC-SHA-256(secret, 'YYYY-MM-DD'), first 128 bits, as a version 8 UUID
 *
 * The **epoch 1** key is the input, never the newest (unlike the asset dedup token): the id must
 * not change when the graph moves to a new Graph Key epoch (ADR 0127), or a day started before a
 * rotation and the same day started after it would get two documents. Every member holds every
 * epoch, so every member derives the same id. The server sees document ids already, and without
 * the key an id is indistinguishable from a random one, so it learns no day from it.
 */

import { utf8 } from './bytes'
import { type GraphKeyring, keyForEpoch } from './keyring'

const INFO = 'etherpk/journal-doc-id/v1'
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The graph's journal id secret (32 bytes). It never changes, so derive it once per session. */
export async function deriveJournalIdSecret(keyring: GraphKeyring): Promise<Uint8Array> {
    const first = keyForEpoch(keyring, 1)
    if (!first) throw new Error('deriveJournalIdSecret: keyring has no epoch 1 key')
    const ikm = await crypto.subtle.importKey('raw', first as BufferSource, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(keyring.graphId) as BufferSource, info: utf8(INFO) as BufferSource },
        ikm,
        256,
    )
    return new Uint8Array(bits)
}

/** The document id of the journal entry for `day` (`YYYY-MM-DD`), under the graph's secret. */
export async function journalDocId(secret: Uint8Array, day: string): Promise<string> {
    if (!DAY.test(day)) throw new Error(`journalDocId: "${day}" is not a calendar day`)
    const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(day) as BufferSource)).slice(0, 16)
    // RFC 9562 version 8 ("custom") with the RFC variant: the sync protocol validates document
    // ids as UUIDs, and a bare 128-bit hash would fail its version and variant check.
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
