import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    type FootprintStorage,
    type ImageFootprintStoreOptions,
    activeImageFootprints,
    createImageFootprintStore,
    imageFootprintsKey,
    persistableImageUrl,
    releaseActiveImageFootprints,
    setActiveImageFootprints,
} from './image-footprints'

/**
 * The image footprints a session leaves for the next (image-footprints.ts). Until a picture has
 * decoded, CodeMirror's height map holds its line as one row tall and its placeholder is a small
 * default box, so the first scroll past each image after a reload moved everything around it. A
 * footprint remembered across sessions sizes both from the start. The browser half (a reload with
 * the picture held back, and a protected document leaving nothing behind) is in
 * tests-client/image-loading.test.ts and tests-client/protected-documents.test.ts.
 */

/** A `localStorage` stand-in that counts its writes. */
function memoryStorage(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial))
    let writes = 0
    const storage: FootprintStorage = {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => {
            writes++
            items.set(key, value)
        },
    }
    return { storage, items, writes: () => writes }
}

const GARDEN = imageFootprintsKey('garden')
const ROSE = { width: 300, height: 226, left: 0 }
const FERN = { width: 640, height: 482, left: 24 }

function store(storage: FootprintStorage | null, options: Partial<ImageFootprintStoreOptions> = {}) {
    return createImageFootprintStore({ storage: () => storage, storageKey: GARDEN, ...options })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    vi.useRealTimers()
    setActiveImageFootprints(null)
})

describe('a footprint', () => {
    it('is remembered for the session whether or not it may be kept', () => {
        const s = store(memoryStorage().storage)
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        s.remember('../assets/fern.png||', FERN, { persist: false })
        expect(s.get('../assets/rose.png||')).toEqual(ROSE)
        expect(s.get('../assets/fern.png||')).toEqual(FERN)
        expect(s.get('../assets/moss.png||')).toBeUndefined()
    })

    it('reaches storage once the save delay has passed, in one write for a page of pictures', () => {
        const mem = memoryStorage()
        const s = store(mem.storage, { saveDelayMs: 1000 })
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        s.remember('../assets/fern.png|300|', FERN, { persist: true })
        expect(mem.writes()).toBe(0)
        vi.advanceTimersByTime(1000)
        expect(mem.writes()).toBe(1)
    })

    it('is there for the next session of the same graph, and not for another graph', () => {
        const mem = memoryStorage()
        const first = store(mem.storage)
        first.remember('../assets/rose.png||', ROSE, { persist: true })
        first.flush()

        expect(store(mem.storage).get('../assets/rose.png||')).toEqual(ROSE)
        const kitchen = createImageFootprintStore({ storage: () => mem.storage, storageKey: imageFootprintsKey('kitchen') })
        expect(kitchen.get('../assets/rose.png||')).toBeUndefined()
    })

    it('remembered not to be kept never reaches storage, and leaves it when remembered so again', () => {
        const mem = memoryStorage()
        const s = store(mem.storage)
        // A picture in a Protected Document: its address is part of the protected text.
        s.remember('../assets/fern.png||', FERN, { persist: false })
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        s.flush()
        expect(mem.items.get(GARDEN)).not.toContain('fern')
        expect(mem.items.get(GARDEN)).toContain('rose')

        s.remember('../assets/rose.png||', ROSE, { persist: false })
        s.flush()
        expect(mem.items.get(GARDEN)).not.toContain('rose')
        expect(s.get('../assets/rose.png||')).toEqual(ROSE)
    })

    it('is written now when the page is going away, and the store stops listening once disposed', () => {
        const mem = memoryStorage()
        let goingAway: (() => void) | null = null
        const s = store(mem.storage, {
            flushOn: (flush) => {
                goingAway = flush
                return () => (goingAway = null)
            },
        })
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        goingAway!()
        expect(mem.writes()).toBe(1)
        expect(store(mem.storage).get('../assets/rose.png||')).toEqual(ROSE)

        s.remember('../assets/fern.png||', FERN, { persist: true })
        s.dispose()
        expect(mem.writes()).toBe(2)
        expect(goingAway).toBeNull()
    })
})

describe('forgetting a document\'s pictures', () => {
    it('drops every footprint of those images, whatever their size hints, here and in storage', () => {
        const mem = memoryStorage()
        const s = store(mem.storage)
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        s.remember('../assets/rose.png|300|', ROSE, { persist: true })
        s.remember('../assets/fern.png||', FERN, { persist: true })
        s.flush()

        s.forgetImages(['../assets/rose.png'])
        s.flush()
        expect(s.get('../assets/rose.png||')).toBeUndefined()
        expect(s.get('../assets/rose.png|300|')).toBeUndefined()
        expect(mem.items.get(GARDEN)).not.toContain('rose')
        expect(store(mem.storage).get('../assets/fern.png||')).toEqual(FERN)
    })
})

describe('two tabs on one graph', () => {
    it('each write keeps what the other tab stored', () => {
        const mem = memoryStorage()
        const first = store(mem.storage)
        const second = store(mem.storage)
        // Both read storage before either writes.
        expect(first.get('x')).toBeUndefined()
        expect(second.get('x')).toBeUndefined()
        first.remember('../assets/rose.png||', ROSE, { persist: true })
        first.flush()
        second.remember('../assets/fern.png||', FERN, { persist: true })
        second.flush()

        const next = store(mem.storage)
        expect(next.get('../assets/rose.png||')).toEqual(ROSE)
        expect(next.get('../assets/fern.png||')).toEqual(FERN)
    })

    it('a tab that read a footprint before another forgot it never writes it back', () => {
        const mem = memoryStorage()
        const seed = store(mem.storage)
        seed.remember('../assets/rose.png||', ROSE, { persist: true })
        seed.flush()

        const reader = store(mem.storage)
        expect(reader.get('../assets/rose.png||')).toEqual(ROSE) // loaded while it was stored
        const protector = store(mem.storage)
        protector.forgetImages(['../assets/rose.png'])
        protector.flush()

        reader.remember('../assets/fern.png||', FERN, { persist: true })
        reader.flush()
        expect(mem.items.get(GARDEN)).not.toContain('rose')
        expect(mem.items.get(GARDEN)).toContain('fern')
    })
})

describe('the remembered set', () => {
    it('keeps the most recently drawn pictures up to its limit, in memory and in storage', () => {
        const mem = memoryStorage()
        const s = store(mem.storage, { limit: 2 })
        s.remember('a||', ROSE, { persist: true })
        s.remember('b||', ROSE, { persist: true })
        s.remember('a||', FERN, { persist: true }) // drawn again: now the most recent
        s.remember('c||', ROSE, { persist: true })
        expect(s.get('b||')).toBeUndefined()
        expect(s.get('a||')).toEqual(FERN)
        s.flush()
        const next = store(mem.storage, { limit: 2 })
        expect(next.get('b||')).toBeUndefined()
        expect(next.get('a||')).toEqual(FERN)
        expect(next.get('c||')).toEqual(ROSE)
    })

    it('reads nothing from a stored value it does not recognise', () => {
        for (const stored of [
            '{not json',
            '[]',
            '{"v":99,"entries":[]}',
            '{"v":1,"entries":[["a||","wide",1,0]]}',
            '{"v":1,"entries":[["a||",300,0,0]]}',
            '{"v":1,"entries":[["a||",300,-40,0]]}',
            '{"v":1,"entries":[["a||",300,1e9,0]]}',
        ]) {
            expect(store(memoryStorage({ [GARDEN]: stored }).storage).get('a||'), stored).toBeUndefined()
        }
    })

    it('works for the session when storage refuses to be read or written', () => {
        const refusing: FootprintStorage = {
            getItem: () => {
                throw new Error('SecurityError')
            },
            setItem: () => {
                throw new Error('QuotaExceededError')
            },
        }
        const s = store(refusing)
        s.remember('../assets/rose.png||', ROSE, { persist: true })
        expect(() => s.flush()).not.toThrow()
        expect(s.get('../assets/rose.png||')).toEqual(ROSE)
    })
})

describe('the active store', () => {
    it('is the open graph\'s, and outside a graph one that keeps nothing past the session', () => {
        const mem = memoryStorage()
        const garden = store(mem.storage)
        setActiveImageFootprints(garden)
        expect(activeImageFootprints()).toBe(garden)

        setActiveImageFootprints(null)
        const none = activeImageFootprints()
        none.remember('../assets/rose.png||', ROSE, { persist: true })
        none.flush()
        expect(none.get('../assets/rose.png||')).toEqual(ROSE)
        expect(mem.writes()).toBe(0)
    })

    it('is not released by a graph that has already been replaced by the next one', () => {
        const garden = store(memoryStorage().storage)
        const kitchen = store(memoryStorage().storage)
        setActiveImageFootprints(garden)
        setActiveImageFootprints(kitchen) // the next graph's workspace mounted first
        releaseActiveImageFootprints(garden) // the last one's teardown
        expect(activeImageFootprints()).toBe(kitchen)
        releaseActiveImageFootprints(kitchen)
        expect(activeImageFootprints()).not.toBe(kitchen)
    })
})

describe('an image address that may be kept', () => {
    it('is an asset reference or a web address', () => {
        expect(persistableImageUrl('../assets/rose.a1b2c3d4.png')).toBe(true)
        expect(persistableImageUrl('https://example.org/rose.png')).toBe(true)
    })

    it('is never a data or blob address, which are the picture itself or die with the session', () => {
        expect(persistableImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false)
        expect(persistableImageUrl('DATA:image/svg+xml,%3Csvg/%3E')).toBe(false)
        expect(persistableImageUrl('blob:https://example.org/0f3c')).toBe(false)
    })

    it('is never one long enough to crowd storage', () => {
        expect(persistableImageUrl(`../assets/${'a'.repeat(600)}.png`)).toBe(false)
    })
})
