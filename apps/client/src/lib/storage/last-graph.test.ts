import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearLastGraphId, getLastGraphId, setLastGraphId } from './last-graph'

/** A minimal in-memory Storage stand-in for the node test environment. */
function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, v),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('last-graph pointer', () => {
    it('round-trips set → get → clear', () => {
        vi.stubGlobal('localStorage', fakeStorage())
        expect(getLastGraphId()).toBeNull()
        setLastGraphId('g-123')
        expect(getLastGraphId()).toBe('g-123')
        clearLastGraphId()
        expect(getLastGraphId()).toBeNull()
    })

    it('returns null and never throws when storage is unavailable', () => {
        vi.stubGlobal('localStorage', undefined)
        expect(getLastGraphId()).toBeNull()
        expect(() => setLastGraphId('g-1')).not.toThrow()
        expect(() => clearLastGraphId()).not.toThrow()
    })

    it('swallows storage access errors (disabled / private mode)', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('denied')
            },
            setItem: () => {
                throw new Error('denied')
            },
            removeItem: () => {
                throw new Error('denied')
            },
        })
        expect(getLastGraphId()).toBeNull()
        expect(() => setLastGraphId('g-1')).not.toThrow()
        expect(() => clearLastGraphId()).not.toThrow()
    })
})
