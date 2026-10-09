import { describe, expect, it, vi } from 'vitest'

import { createExtensionSwitches, EXTENSION_SWITCHES_KEY } from './switches'

/** A Storage over a plain map, as localStorage behaves. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
    const values = new Map(Object.entries(initial))
    return {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    }
}

describe('extension switches', () => {
    it('has every extension on until it is switched off', () => {
        const switches = createExtensionSwitches(memoryStorage())
        expect(switches.isOn('graph-view')).toBe(true)
    })

    it('remembers a switch on this device, as a list of what is off', () => {
        const storage = memoryStorage()
        createExtensionSwitches(storage).set('graph-view', false)
        expect(JSON.parse(storage.getItem(EXTENSION_SWITCHES_KEY) ?? '[]')).toEqual(['graph-view'])
        expect(createExtensionSwitches(storage).isOn('graph-view')).toBe(false)
        createExtensionSwitches(storage).set('graph-view', true)
        expect(createExtensionSwitches(storage).isOn('graph-view')).toBe(true)
    })

    it('tells its listeners about a change, and only a change', () => {
        const switches = createExtensionSwitches(memoryStorage())
        const listener = vi.fn()
        const stop = switches.subscribe(listener)
        switches.set('kanban', false)
        switches.set('kanban', false)
        expect(listener).toHaveBeenCalledTimes(1)
        stop()
        switches.set('kanban', true)
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('reads unreadable storage as everything on, and keeps working without storage', () => {
        expect(createExtensionSwitches(memoryStorage({ [EXTENSION_SWITCHES_KEY]: '{oops' })).isOn('kanban')).toBe(true)
        const switches = createExtensionSwitches(undefined)
        switches.set('kanban', false)
        expect(switches.isOn('kanban')).toBe(false)
    })
})
