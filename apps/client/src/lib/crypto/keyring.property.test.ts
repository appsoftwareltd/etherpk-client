import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type GraphKeyring, KeyringConflictError, deserializeKeyrings, mergeKeyringEpochs, serializeKeyrings } from './keyring'

/**
 * How many cases a property runs, and from which seed. The seed is fixed so a run is the same here
 * and in CI. `CRYPTO_FUZZ_RUNS` and `CRYPTO_FUZZ_SEED` change them for a longer local run, or to
 * replay a failure fast-check reported.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.CRYPTO_FUZZ_SEED
    return { numRuns: Number(process.env.CRYPTO_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261116 : Number(seed) }
}

/**
 * A Client's keyring for a graph grows by merging: an invite, a copy of a new epoch, a second
 * device's vault. Whichever order the copies arrive in, the result must be the same keyring, and
 * two different keys under one epoch number must never merge silently.
 */

const GRAPH = 'graph-garden'

/** The graph's real keys by epoch number, and two holders who each have some of them. */
const scenario = fc
    .uniqueArray(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 8 })
    .chain((epochIds) =>
        fc.record({
            keys: fc.tuple(...epochIds.map(() => fc.uint8Array({ minLength: 32, maxLength: 32 }))).map((keys) => new Map(epochIds.map((id, i) => [id, keys[i]]))),
            held: fc.subarray(epochIds),
            incoming: fc.subarray(epochIds),
        }),
    )

function keyring(keys: Map<number, Uint8Array>, epochIds: number[]): GraphKeyring {
    return { graphId: GRAPH, epochs: [...epochIds].sort((a, b) => a - b).map((epochId) => ({ epochId, key: keys.get(epochId)! })) }
}

function plain(ring: GraphKeyring) {
    return { graphId: ring.graphId, epochs: ring.epochs.map((e) => ({ epochId: e.epochId, key: Array.from(e.key) })) }
}

describe('merging keyrings holds for any two holders of one graph’s keys', () => {
    it('gives every epoch either held, once each, in ascending order', () => {
        fc.assert(
            fc.property(scenario, ({ keys, held, incoming }) => {
                const merged = mergeKeyringEpochs(keyring(keys, held), keyring(keys, incoming))
                const expected = [...new Set([...held, ...incoming])].sort((a, b) => a - b)
                expect(merged.epochs.map((e) => e.epochId)).toEqual(expected)
                for (const epoch of merged.epochs) expect(Array.from(epoch.key)).toEqual(Array.from(keys.get(epoch.epochId)!))
            }),
            fuzz(500),
        )
    })

    it('gives the same keyring whichever copy arrives first, and changes nothing when merged again', () => {
        fc.assert(
            fc.property(scenario, ({ keys, held, incoming }) => {
                const a = keyring(keys, held)
                const b = keyring(keys, incoming)
                const merged = mergeKeyringEpochs(a, b)
                expect(plain(mergeKeyringEpochs(b, a))).toEqual(plain(merged))
                expect(plain(mergeKeyringEpochs(merged, b))).toEqual(plain(merged))
                expect(plain(mergeKeyringEpochs(merged, merged))).toEqual(plain(merged))
            }),
            fuzz(500),
        )
    })

    it('refuses two different keys under one epoch number, and names the epoch', () => {
        fc.assert(
            fc.property(scenario, fc.nat(), fc.integer({ min: 1, max: 255 }), ({ keys, held, incoming }, pick, flip) => {
                const shared = held.filter((id) => incoming.includes(id))
                fc.pre(shared.length > 0)
                const epochId = shared[pick % shared.length]
                const forged = new Map(keys)
                const other = Uint8Array.from(keys.get(epochId)!)
                other[0] ^= flip
                forged.set(epochId, other)
                let thrown: unknown
                try {
                    mergeKeyringEpochs(keyring(keys, held), keyring(forged, incoming))
                } catch (error) {
                    thrown = error
                }
                expect(thrown).toBeInstanceOf(KeyringConflictError)
                expect((thrown as KeyringConflictError).epochId).toBe(epochId)
            }),
            fuzz(300),
        )
    })

    it('reads back the keyrings it wrote', () => {
        fc.assert(
            fc.property(scenario, ({ keys, held, incoming }) => {
                const rings = [keyring(keys, held), keyring(keys, incoming)]
                expect(deserializeKeyrings(serializeKeyrings(rings)).map(plain)).toEqual(rings.map(plain))
            }),
            fuzz(300),
        )
    })
})
