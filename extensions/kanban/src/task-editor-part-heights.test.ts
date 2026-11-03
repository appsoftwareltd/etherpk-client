import { describe, expect, it } from 'vitest'

import { createPartHeights } from './task-editor-part-heights'

// How tall a person has made each of the Task Editor's part editors, kept on this device.

function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
        clear: () => values.clear(),
        key: (index) => [...values.keys()][index] ?? null,
        get length() {
            return values.size
        },
    }
}

describe("the Task Editor's part heights", () => {
    it('are none until a part is resized, then that part keeps its height', () => {
        const storage = memoryStorage()
        const heights = createPartHeights(storage)
        expect(heights.get('description')).toBeNull()
        heights.set('description', 320)
        expect(heights.get('description')).toBe(320)
        expect(heights.get('comments')).toBeNull()
        // Read back by another Task Editor on this device.
        expect(createPartHeights(storage).get('description')).toBe(320)
    })

    it('keep each part apart', () => {
        const heights = createPartHeights(memoryStorage())
        heights.set('comments', 240)
        heights.set('additionalContext', 400)
        expect([heights.get('description'), heights.get('comments'), heights.get('additionalContext')]).toEqual([null, 240, 400])
    })

    it('ignore what cannot be read, and never throw when storage does', () => {
        const storage = memoryStorage()
        storage.setItem('etherpk-kanban-task-editor-part-heights', '{"description":"tall"}')
        expect(createPartHeights(storage).get('description')).toBeNull()
        const refusing = {
            ...memoryStorage(),
            getItem: () => {
                throw new Error('blocked')
            },
            setItem: () => {
                throw new Error('blocked')
            },
        } as Storage
        const heights = createPartHeights(refusing)
        expect(() => heights.set('description', 300)).not.toThrow()
        expect(heights.get('description')).toBeNull()
        expect(createPartHeights(undefined).get('description')).toBeNull()
    })
})
