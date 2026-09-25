import { afterEach, describe, expect, it } from 'vitest'

import { registerPositionAdapter, restorePosition } from './position'

describe('pending restores', () => {
    let detach: (() => void) | undefined
    afterEach(() => detach?.())

    it('queues a restore for an unmounted key and delivers it on registration', () => {
        const restored: number[] = []
        expect(restorePosition('document:X', { scrollTop: 9, anchor: 0, head: 0 })).toBe(false)
        detach = registerPositionAdapter('document:X', {
            capture: () => null,
            restore: (p) => void restored.push(p.scrollTop),
        })
        expect(restored).toEqual([9])
        // delivered once, not again on a second registration
        detach()
        detach = registerPositionAdapter('document:X', {
            capture: () => null,
            restore: (p) => void restored.push(p.scrollTop),
        })
        expect(restored).toEqual([9])
    })

    it('restores immediately when the adapter is mounted', () => {
        const restored: number[] = []
        detach = registerPositionAdapter('document:Y', {
            capture: () => null,
            restore: (p) => void restored.push(p.scrollTop),
        })
        expect(restorePosition('document:Y', { scrollTop: 3, anchor: 0, head: 0 })).toBe(true)
        expect(restored).toEqual([3])
    })
})
