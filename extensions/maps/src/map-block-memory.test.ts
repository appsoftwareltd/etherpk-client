import { describe, expect, it } from 'vitest'

import { createMapBlockMemory, type MapBlockStorage, textFingerprint } from './map-block-memory'

// What one device remembers about its Map Blocks (ADR 0118): which are folded, known by the map's
// own text in its document, so maps put in, moved or deleted round a map never pass it their folds.

function storage(): MapBlockStorage & { keys(): string[] } {
    const items = new Map<string, string>()
    return {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
        keys: () => [...items.keys()],
    }
}

const harbour = { document: 'Trips', body: ['Harbour @ 50.70000, -1.50000'] }
const quay = { document: 'Trips', body: ['Quay @ 50.71000, -1.51000'] }

describe('the folds this device remembers', () => {
    it('finds a fold again by the map’s text in its document, wherever the map has moved to', () => {
        const memory = createMapBlockMemory('graph', storage())
        memory.setFolded(harbour, true)
        expect(memory.folded(harbour)).toBe(true)
        // Another map, the same map in another document, and a new, empty map are all open.
        expect(memory.folded(quay)).toBe(false)
        expect(memory.folded({ ...harbour, document: 'Walks' })).toBe(false)
        expect(memory.folded({ document: 'Trips', body: [] })).toBe(false)
    })

    it('reads its folds back after a reload, and lets one go when the map is unfolded', () => {
        const device = storage()
        createMapBlockMemory('graph', device).setFolded(harbour, true)
        const reloaded = createMapBlockMemory('graph', device)
        expect(reloaded.folded(harbour)).toBe(true)
        reloaded.setFolded(harbour, false)
        expect(reloaded.folded(harbour)).toBe(false)
        expect(device.keys()).toEqual([])
        // Each graph keeps its own.
        createMapBlockMemory('graph', device).setFolded(harbour, true)
        expect(createMapBlockMemory('other graph', device).folded(harbour)).toBe(false)
    })

    it('folds two maps with the same text in one document together, and a change of text unfolds one', () => {
        const memory = createMapBlockMemory('graph', storage())
        memory.setFolded(harbour, true)
        expect(memory.folded({ document: 'Trips', body: [...harbour.body] })).toBe(true)
        expect(memory.folded({ document: 'Trips', body: [...harbour.body, 'Quay @ 50.71000, -1.51000'] })).toBe(false)
    })

    it('tells its listeners of every change, until they stop', () => {
        const memory = createMapBlockMemory('graph', storage())
        let heard = 0
        const stop = memory.subscribe(() => heard++)
        memory.setFolded(harbour, true)
        memory.setFolded(harbour, false)
        expect(heard).toBe(2)
        stop()
        memory.setFolded(harbour, true)
        expect(heard).toBe(2)
    })

    it('keeps folds for the page where the device keeps none', () => {
        const refused: MapBlockStorage = {
            getItem: () => {
                throw new Error('refused')
            },
            setItem: () => {
                throw new Error('refused')
            },
            removeItem: () => {
                throw new Error('refused')
            },
        }
        for (const memory of [createMapBlockMemory('graph', null), createMapBlockMemory('graph', refused)]) {
            memory.setFolded(harbour, true)
            expect(memory.folded(harbour)).toBe(true)
            expect(memory.folded(quay)).toBe(false)
        }
        // An editor outside any document folds its maps for the page too.
        const outside = createMapBlockMemory('graph', storage())
        outside.setFolded({ document: null, body: harbour.body }, true)
        expect(outside.folded({ document: null, body: harbour.body })).toBe(true)
    })

    it('fingerprints a map’s text in eight hex digits, the same text alike', () => {
        expect(textFingerprint(harbour.body)).toMatch(/^[0-9a-f]{8}$/)
        expect(textFingerprint([...harbour.body])).toBe(textFingerprint(harbour.body))
        expect(textFingerprint(quay.body)).not.toBe(textFingerprint(harbour.body))
        // Lines are kept apart: two lines are not their joined text.
        expect(textFingerprint(['ab', 'c'])).not.toBe(textFingerprint(['a', 'bc']))
    })
})
