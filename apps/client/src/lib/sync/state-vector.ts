import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'

/**
 * A Yjs state vector is a set of per-client clocks. Relay acknowledgement and remote-update
 * order are independent, so replacing one vector with another can forget already-confirmed
 * structs. The union is the component-wise maximum.
 */
export function mergeStateVectors(...vectors: readonly Uint8Array[]): Uint8Array {
    const clocks = new Map<number, number>()
    for (const vector of vectors) {
        if (vector.byteLength === 0) continue
        for (const [client, clock] of Y.decodeStateVector(vector)) {
            clocks.set(client, Math.max(clocks.get(client) ?? 0, clock))
        }
    }

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, clocks.size)
    // Stable ordering is not required by Yjs, but deterministic bytes make cache diagnostics
    // and tests much easier to reason about.
    for (const [client, clock] of [...clocks].sort(([a], [b]) => a - b)) {
        encoding.writeVarUint(encoder, client)
        encoding.writeVarUint(encoder, clock)
    }
    return encoding.toUint8Array(encoder)
}

/** True when every client clock in `required` is present in `actual` at least as far. */
export function stateVectorCovers(actual: Uint8Array, required: Uint8Array): boolean {
    const actualClocks = Y.decodeStateVector(actual)
    for (const [client, clock] of Y.decodeStateVector(required)) {
        if ((actualClocks.get(client) ?? 0) < clock) return false
    }
    return true
}
