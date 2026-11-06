import { describe, expect, it } from 'vitest'

import { createMapBlockMemory } from './map-block-memory'
import type { MapBlockServices } from './map-block-services'
import { MAP_HEIGHT_FOLDED, createMapFence } from './map-fence.svelte'
import { MAP_HEIGHT_WIDE } from './map-size'

// The room the editor keeps for a Map Block (ADR 0118), which it asks before the widget mounts.

const garden = 'Garden @ 50.74860, -4.07890'
const info = (...body: string[]) => ({ info: 'map', body, document: 'Trips', ordinal: 0 })

function fenceWithMemory() {
    const memory = createMapBlockMemory('graph', null)
    return { memory, fence: createMapFence({ memory } as unknown as MapBlockServices) }
}

describe('the room a Map Block takes', () => {
    it('is the default with no size line', () => {
        expect(fenceWithMemory().fence.height(info(garden))).toBe(MAP_HEIGHT_WIDE)
    })

    it('is the height its size line says', () => {
        expect(fenceWithMemory().fence.height(info('size 640x500', garden))).toBe(500)
    })

    it('is the folded bar’s while it is folded, whatever its size line says', () => {
        const { memory, fence } = fenceWithMemory()
        memory.setFolded(info('size 640x500', garden), true)
        expect(fence.height(info('size 640x500', garden))).toBe(MAP_HEIGHT_FOLDED)
    })
})
