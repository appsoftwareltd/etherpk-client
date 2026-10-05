/**
 * The Graph Key as it actually exists: an ordered list of epoch keys (ADR 0026).
 * The last entry is the current epoch; older epochs decrypt not-yet-compacted history.
 * Immutable: bumpEpoch returns a new keyring (removing a Player = bump + re-seal).
 */
import { bytesEqual, fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'

export interface EpochKey {
    epochId: number
    key: Uint8Array
}

export interface GraphKeyring {
    graphId: string
    /** Ascending by epochId; last is current. */
    epochs: EpochKey[]
}

/**
 * A graph's keyring, or a way to read the current one. A session that can follow a new Graph Key
 * epoch (ADR 0127) passes a getter, so every seal and open reads the keyring as it is now.
 */
export type KeyringSource = GraphKeyring | (() => GraphKeyring)

export function keyringReader(source: KeyringSource): () => GraphKeyring {
    return typeof source === 'function' ? source : () => source
}

export function createGraphKeyring(graphId: string): GraphKeyring {
    return { graphId, epochs: [{ epochId: 1, key: randomBytes(32) }] }
}

export function bumpEpoch(keyring: GraphKeyring): GraphKeyring {
    const nextId = currentEpoch(keyring).epochId + 1
    return { ...keyring, epochs: [...keyring.epochs, { epochId: nextId, key: randomBytes(32) }] }
}

export function currentEpoch(keyring: GraphKeyring): EpochKey {
    return keyring.epochs[keyring.epochs.length - 1]
}

export function keyForEpoch(keyring: GraphKeyring, epochId: number): Uint8Array | undefined {
    return keyring.epochs.find((e) => e.epochId === epochId)?.key
}

/** Two keyrings for one graph hold different keys under the same epoch number. */
export class KeyringConflictError extends Error {
    constructor(
        readonly graphId: string,
        readonly epochId: number,
    ) {
        super(`The key for epoch ${epochId} of graph ${graphId} differs from the one already held.`)
        this.name = 'KeyringConflictError'
    }
}

/**
 * The epochs of both keyrings, by epoch number (ADR 0126): how a Player who left and is invited
 * back keeps the epochs they held and gains the ones made since. An epoch number held under a
 * different key in each is a conflict, and nothing is merged: one of the two is not the graph's
 * key, and choosing between them is not something to do silently.
 */
export function mergeKeyringEpochs(held: GraphKeyring, incoming: GraphKeyring): GraphKeyring {
    if (held.graphId !== incoming.graphId) throw new Error('keyrings for different graphs cannot be merged')
    const byEpoch = new Map(held.epochs.map((epoch) => [epoch.epochId, epoch]))
    for (const epoch of incoming.epochs) {
        const existing = byEpoch.get(epoch.epochId)
        if (existing && !bytesEqual(existing.key, epoch.key)) throw new KeyringConflictError(held.graphId, epoch.epochId)
        if (!existing) byEpoch.set(epoch.epochId, epoch)
    }
    return { graphId: held.graphId, epochs: [...byEpoch.values()].sort((a, b) => a.epochId - b.epochId) }
}

export interface KeyringJson {
    graphId: string
    epochs: Array<{ epochId: number; key: string }>
}

export function keyringsToJson(keyrings: GraphKeyring[]): KeyringJson[] {
    return keyrings.map((k) => ({
        graphId: k.graphId,
        epochs: k.epochs.map((e) => ({ epochId: e.epochId, key: toBase64Url(e.key) })),
    }))
}

export function keyringsFromJson(json: KeyringJson[]): GraphKeyring[] {
    return json.map((k) => ({
        graphId: k.graphId,
        epochs: k.epochs.map((e) => ({ epochId: e.epochId, key: fromBase64Url(e.key) })),
    }))
}

/** Plaintext bytes — only ever stored *inside* a vault or sealed box, never bare. */
export function serializeKeyrings(keyrings: GraphKeyring[]): Uint8Array {
    return utf8(JSON.stringify(keyringsToJson(keyrings)))
}

export function deserializeKeyrings(bytes: Uint8Array): GraphKeyring[] {
    return keyringsFromJson(JSON.parse(new TextDecoder().decode(bytes)) as KeyringJson[])
}
