/**
 * The **asset dedup token** (ADR 0053): a per-graph blinded value the Sync Server can index to
 * answer "does this graph already hold these bytes?" without ever learning what the bytes are.
 *
 * ADR 0027 keeps the plaintext content hash out of the server's sight, because a plaintext
 * hash enables confirmation attacks and cross-user dedup. This token keeps that property:
 *
 *   secret = HKDF-SHA-256(ikm = first epoch key, salt = graph id, info = 'etherpk/asset-dedup/v1')
 *   token  = HMAC-SHA-256(secret, content hash hex)
 *
 * The **first** epoch key is the input, not the current one: epoch keys are never pruned from
 * a keyring and every Player holds the whole ring, so every device in a graph derives the same
 * secret for the graph's whole life, across every epoch bump. A keyless ownership transfer or
 * a reset mints a new keyring, so tokens from before it stop matching and reuse restarts from
 * that point - a missed reuse, never a wrong one. Without the secret the token is
 * indistinguishable from random, so the server can tell two assets in *one* graph are identical
 * and nothing more; the secret is per graph, so nothing compares across graphs.
 */

import { utf8 } from './bytes'
import type { GraphKeyring } from './keyring'

const INFO = 'etherpk/asset-dedup/v1'

/** The per-graph dedup secret (32 bytes). Derive once per store; it never changes for a keyring. */
export async function deriveAssetDedupSecret(keyring: GraphKeyring): Promise<Uint8Array> {
    // Ascending by epochId, so [0] is the earliest key this keyring holds. For a keyring that
    // has held every epoch since creation that is epoch 1.
    const first = keyring.epochs[0]
    if (!first) throw new Error('deriveAssetDedupSecret: keyring has no epochs')
    const ikm = await crypto.subtle.importKey('raw', first.key as BufferSource, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(keyring.graphId) as BufferSource, info: utf8(INFO) as BufferSource },
        ikm,
        256,
    )
    return new Uint8Array(bits)
}

/** The token for one asset: HMAC-SHA-256 of its plaintext content hash (hex) under the secret, as 64 hex chars. */
export async function assetDedupToken(secret: Uint8Array, contentHashHex: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(contentHashHex) as BufferSource))
    return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}
