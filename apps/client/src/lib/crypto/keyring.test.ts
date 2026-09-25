import { describe, expect, it } from 'vitest'
import {
    bumpEpoch, createGraphKeyring, currentEpoch, deserializeKeyrings, keyForEpoch, serializeKeyrings,
} from './keyring'

describe('graph keyring', () => {
    it('starts at epoch 1 with a 32-byte key', () => {
        const keyring = createGraphKeyring('g1')
        expect(keyring.graphId).toBe('g1')
        expect(currentEpoch(keyring).epochId).toBe(1)
        expect(currentEpoch(keyring).key).toHaveLength(32)
    })
    it('bump appends a fresh epoch and keeps history (immutably)', () => {
        const first = createGraphKeyring('g1')
        const second = bumpEpoch(first)
        expect(currentEpoch(first).epochId).toBe(1) // input untouched
        expect(currentEpoch(second).epochId).toBe(2)
        expect(second.epochs).toHaveLength(2)
        expect(Buffer.from(keyForEpoch(second, 1)!).equals(Buffer.from(keyForEpoch(second, 2)!))).toBe(false)
        expect(keyForEpoch(second, 3)).toBeUndefined()
    })
    it('serializes and round-trips', () => {
        const keyrings = [bumpEpoch(createGraphKeyring('g1')), createGraphKeyring('g2')]
        const back = deserializeKeyrings(serializeKeyrings(keyrings))
        expect(back).toHaveLength(2)
        expect(back[0].graphId).toBe('g1')
        expect(back[0].epochs.map((e) => e.epochId)).toEqual([1, 2])
        expect(Buffer.from(back[0].epochs[1].key).equals(Buffer.from(keyrings[0].epochs[1].key))).toBe(true)
    })
})
