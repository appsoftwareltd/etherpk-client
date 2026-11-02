import { describe, expect, it } from 'vitest'

import { createAgentHint } from './agent-hint'

// The line above a board's lanes that says an agent can work on its tasks: shown until a person
// dismisses it, then gone on every board on this device.

function memoryStorage(): Storage {
    const items = new Map<string, string>()
    return {
        get length() {
            return items.size
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, value),
    }
}

describe('the agent hint', () => {
    it('shows until it is dismissed, and stays dismissed for every board on the device', () => {
        const storage = memoryStorage()
        expect(createAgentHint(storage).shown()).toBe(true)
        createAgentHint(storage).dismiss()
        expect(createAgentHint(storage).shown()).toBe(false)
    })

    it('shows, and can still be dismissed for now, where storage throws or is missing', () => {
        const throwing = { ...memoryStorage(), getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } as Storage
        const hint = createAgentHint(throwing)
        expect(hint.shown()).toBe(true)
        expect(() => hint.dismiss()).not.toThrow()
        expect(createAgentHint(undefined).shown()).toBe(true)
    })
})
