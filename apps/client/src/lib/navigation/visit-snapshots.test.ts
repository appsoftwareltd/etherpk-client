import { describe, expect, it } from 'vitest'

import { VISIT_SNAPSHOTS_KEY, createVisitSnapshots } from './visit-snapshots'

function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k: string) => map.get(k) ?? null,
        key: (i: number) => [...map.keys()][i] ?? null,
        removeItem: (k: string) => void map.delete(k),
        setItem: (k: string, v: string) => void map.set(k, v),
    }
}

describe('createVisitSnapshots', () => {
    it('round-trips a snapshot by visit id, across instances (same tab)', () => {
        const storage = fakeStorage()
        createVisitSnapshots(storage).save(7, { scrollTop: 44, anchor: 2, head: 9 })
        expect(createVisitSnapshots(storage).load(7)).toEqual({ scrollTop: 44, anchor: 2, head: 9 })
    })
    it('returns null for unknown ids and ignores null saves', () => {
        const snapshots = createVisitSnapshots(fakeStorage())
        snapshots.save(1, null)
        expect(snapshots.load(1)).toBeNull()
        expect(snapshots.load(999)).toBeNull()
    })
    it('caps stored snapshots by insertion recency', () => {
        const storage = fakeStorage()
        const snapshots = createVisitSnapshots(storage)
        for (let i = 0; i < 130; i++) snapshots.save(i, { scrollTop: i, anchor: 0, head: 0 })
        expect(snapshots.load(0)).toBeNull()
        expect(snapshots.load(129)).not.toBeNull()
        expect(storage.getItem(VISIT_SNAPSHOTS_KEY)).not.toBeNull()
    })
    it('degrades a corrupt payload to empty', () => {
        const storage = fakeStorage()
        storage.setItem(VISIT_SNAPSHOTS_KEY, 'not json')
        expect(createVisitSnapshots(storage).load(1)).toBeNull()
    })
})
