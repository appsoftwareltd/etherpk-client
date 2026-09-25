/**
 * The **name envelope** (ADR 0031, amended 2026-09-17): a graph's name encrypted under its
 * Graph Key and stored by the Sync Server beside the graph, as bytes it cannot read.
 *
 * The canonical [[Graph Name]] lives in the graph-root document's `meta` map, which a device
 * can only read by opening the graph. The envelope is one sealed copy of that name per graph,
 * held by the Server as an opaque column, so the /graphs picker and the [[Headless Client]]'s
 * `graphs` command can label a graph the device has never opened. It is a label, never the
 * source of truth: whoever sees the canonical name republishes it (graph-sync.ts), and a
 * stale envelope is corrected by the next open.
 *
 * Sealed under the Graph Key like everything else, with the envelope's AAD bound to the graph
 * id so a server that swapped two rows' columns could not relabel one graph with another's
 * name. The plaintext is padded into 64-byte buckets so the ciphertext length reveals little
 * about the name.
 */
// Relative rather than `$lib`: the Playwright fixtures seal and open name envelopes with this
// module, and the test process resolves no alias (the crypto modules are relative for the same reason).
import {
    contextAad,
    currentEpoch,
    keyForEpoch,
    openSymmetric,
    sealSymmetric,
    toBase64Url,
    type GraphKeyring,
} from '../crypto'

import type { SyncApi } from './sync-api'

/** Longest name an envelope carries, in UTF-8 bytes. The meta map is not bound by this. */
export const GRAPH_NAME_MAX_BYTES = 512
const PAD_TO = 64
const LENGTH_PREFIX = 2

function graphNameAad(graphId: string): Uint8Array {
    return contextAad('graph-name', `graph:${graphId}`)
}

/** Seal a name into an envelope under the keyring's current epoch. */
export async function sealGraphName(keyring: GraphKeyring, graphId: string, name: string): Promise<Uint8Array> {
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('graph name is empty')
    const utf8 = new TextEncoder().encode(trimmed)
    if (utf8.byteLength > GRAPH_NAME_MAX_BYTES) throw new Error(`graph name is too long for the envelope (${utf8.byteLength} bytes)`)
    // [u16 BE length][utf8][zero padding to the next 64-byte bucket]
    const padded = new Uint8Array(Math.ceil((LENGTH_PREFIX + utf8.byteLength) / PAD_TO) * PAD_TO)
    new DataView(padded.buffer).setUint16(0, utf8.byteLength, false)
    padded.set(utf8, LENGTH_PREFIX)
    const epoch = currentEpoch(keyring)
    return sealSymmetric({ key: epoch.key, epochId: epoch.epochId, plaintext: padded, aad: graphNameAad(graphId) })
}

/**
 * Read the name from an envelope, or null when this keyring cannot: a missing epoch, another graph's
 * envelope, tampered or malformed bytes. Callers treat null as "no label", never as an error,
 * because the envelope is only ever a convenience.
 */
export async function openGraphName(keyring: GraphKeyring, graphId: string, envelope: Uint8Array): Promise<string | null> {
    try {
        const { plaintext } = await openSymmetric({
            keyForEpoch: (epochId) => keyForEpoch(keyring, epochId),
            envelope,
            aad: graphNameAad(graphId),
        })
        if (plaintext.byteLength < LENGTH_PREFIX) return null
        const length = new DataView(plaintext.buffer, plaintext.byteOffset).getUint16(0, false)
        if (length === 0 || LENGTH_PREFIX + length > plaintext.byteLength) return null
        return new TextDecoder().decode(plaintext.subarray(LENGTH_PREFIX, LENGTH_PREFIX + length))
    } catch {
        // WebCrypto reports a bad key or tampered bytes as a DOMException, not an Error subclass
        // in every runtime; whatever the cause, the answer is the same: no label.
        return null
    }
}

export interface GraphNamePublisher {
    /** Seal and send `name`; requests are sent one at a time, in the order they were made. */
    publish(name: string): void
    /** Resolves once every publish requested so far has been sent, or has failed. */
    settled(): Promise<void>
}

export interface GraphNamePublisherDeps {
    api: Pick<SyncApi, 'setGraphName'>
    keyring: GraphKeyring
    graphId: string
    /** A failed publish is reported, never thrown: the meta map still holds the name. */
    onError?: (error: Error) => void
}

/**
 * The write side of the envelope, for `GraphSyncDeps.publishName`. Sends are chained so two
 * renames in quick succession cannot land on the server out of order, and a failure (offline,
 * an older server without the route) is reported and does not stop the next one.
 */
export function createGraphNamePublisher(deps: GraphNamePublisherDeps): GraphNamePublisher {
    const report = deps.onError ?? ((error: Error) => console.warn('[sync] could not publish the graph name envelope', error))
    let chain: Promise<void> = Promise.resolve()
    return {
        publish(name) {
            chain = chain.then(async () => {
                try {
                    const envelope = await sealGraphName(deps.keyring, deps.graphId, name)
                    await deps.api.setGraphName(deps.graphId, toBase64Url(envelope))
                } catch (err) {
                    report(err instanceof Error ? err : new Error(String(err)))
                }
            })
        },
        settled: () => chain,
    }
}
