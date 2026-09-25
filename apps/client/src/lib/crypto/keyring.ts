/**
 * The Graph Key as it actually exists: an ordered list of epoch keys (ADR 0026).
 * The last entry is the current epoch; older epochs decrypt not-yet-compacted history.
 * Immutable: bumpEpoch returns a new keyring (removing a Player = bump + re-seal).
 */
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'

export interface EpochKey {
    epochId: number
    key: Uint8Array
}

export interface GraphKeyring {
    graphId: string
    /** Ascending by epochId; last is current. */
    epochs: EpochKey[]
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
