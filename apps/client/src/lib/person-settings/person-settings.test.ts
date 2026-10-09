import { describe, expect, it, vi } from 'vitest'

import { createPersonSettings, extensionSettingKey, PERSON_SETTINGS_STORAGE_KEY, readPersonSettings } from './person-settings'

// A person's settings (ADR 0134): kept on the device, and merged with the account's vault where the
// account syncs, the later change winning setting by setting.

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

/** A store over `storage` whose clock is `time`, which a test moves on. */
function store(storage = memoryStorage()) {
    let time = 1_000
    const settings = createPersonSettings(() => storage, () => time)
    return { settings, storage, at: (next: number) => (time = next) }
}

const KEY = extensionSettingKey('maps', 'mapbox-token')

describe('a setting on this device', () => {
    it('is set, read and cleared, empty text clearing it, and kept for the next page', () => {
        const { settings, storage } = store()
        expect(KEY).toBe('extension.maps.mapbox-token')
        expect(settings.get(KEY)).toBeUndefined()
        settings.set(KEY, ' pk.one ')
        expect(settings.get(KEY)).toBe('pk.one')
        expect(createPersonSettings(() => storage).get(KEY)).toBe('pk.one')
        settings.set(KEY, '  ')
        expect(settings.get(KEY)).toBeUndefined()
    })

    it('tells its listeners of a change, and of nothing when the value is the same', () => {
        const { settings } = store()
        const heard = vi.fn()
        settings.subscribe(heard)
        settings.set(KEY, 'pk.one')
        settings.set(KEY, 'pk.one')
        expect(heard).toHaveBeenCalledTimes(1)
    })

    it('follows another tab that changed it', () => {
        const { settings, storage } = store()
        const other = createPersonSettings(() => storage)
        const heard = vi.fn()
        settings.subscribe(heard)
        other.set(KEY, 'pk.two')
        settings.storageChanged(PERSON_SETTINGS_STORAGE_KEY)
        expect(settings.get(KEY)).toBe('pk.two')
        expect(heard).toHaveBeenCalledTimes(1)
        settings.storageChanged('etherpk:something-else')
        expect(heard).toHaveBeenCalledTimes(1)
    })

    it('keeps working in memory when the browser refuses storage', () => {
        const refusing = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } } as unknown as Storage
        const settings = createPersonSettings(() => refusing)
        settings.set(KEY, 'pk.one')
        expect(settings.get(KEY)).toBe('pk.one')
    })
})

describe('merging with the account’s vault', () => {
    it('on a device’s first sync, takes the vault’s values and gives it only what it lacks', () => {
        const { settings, at } = store()
        at(5_000)
        settings.set(KEY, 'pk.this-device')
        settings.set('extension.kanban.colour', 'blue')
        const give = settings.merge('https://sync.example A1', { [KEY]: { value: 'pk.account', changedAt: 2_000 } })
        expect(settings.get(KEY)).toBe('pk.account')
        expect(give).toEqual({ 'extension.kanban.colour': { value: 'blue', changedAt: 5_000 } })
        settings.delivered('https://sync.example A1', give)
        expect(settings.syncedWith()).toBe('https://sync.example A1')
    })

    it('afterwards, the later change wins setting by setting, a clearing included', () => {
        const { settings, at } = store()
        settings.merge('A', {})
        settings.delivered('A', {})
        at(3_000)
        settings.set(KEY, 'pk.later-here')
        at(4_000)
        settings.set('extension.maps.other', 'old here')
        const give = settings.merge('A', {
            [KEY]: { value: 'pk.earlier-there', changedAt: 2_000 },
            'extension.maps.other': { value: null, changedAt: 9_000 },
        })
        expect(settings.get(KEY)).toBe('pk.later-here')
        expect(settings.get('extension.maps.other')).toBeUndefined()
        expect(give).toEqual({ [KEY]: { value: 'pk.later-here', changedAt: 3_000 } })
    })

    it('takes a value this device did not change, however its time compares', () => {
        const { settings, at } = store()
        at(8_000)
        settings.set(KEY, 'pk.here')
        settings.delivered('A', settings.merge('A', {}))
        settings.merge('A', { [KEY]: { value: 'pk.there', changedAt: 7_000 } })
        expect(settings.get(KEY)).toBe('pk.there')
    })

    it('keeps a change made while the vault was being written pending', () => {
        const { settings, at } = store()
        settings.delivered('A', settings.merge('A', {}))
        at(2_000)
        settings.set(KEY, 'pk.first')
        const give = settings.merge('A', {})
        at(3_000)
        settings.set(KEY, 'pk.second')
        settings.delivered('A', give)
        expect(settings.merge('A', { [KEY]: { value: 'pk.first', changedAt: 2_000 } })).toEqual({ [KEY]: { value: 'pk.second', changedAt: 3_000 } })
    })

    it('after syncing with another account, takes the new one’s settings as they are and gives it nothing', () => {
        const { settings } = store()
        settings.set(KEY, 'pk.first-person')
        settings.delivered('A', settings.merge('A', {}))
        settings.set('extension.maps.other', 'theirs too')
        expect(settings.merge('B', { 'extension.kanban.colour': { value: 'green', changedAt: 1 } })).toEqual({})
        expect(settings.get(KEY)).toBeUndefined()
        expect(settings.get('extension.maps.other')).toBeUndefined()
        expect(settings.get('extension.kanban.colour')).toBe('green')
    })

    it('says whether a change here has yet to reach the vault', () => {
        const { settings } = store()
        expect(settings.hasPending()).toBe(false)
        settings.set(KEY, 'pk.one')
        expect(settings.hasPending()).toBe(true)
        settings.delivered('https://sync.example A1', settings.merge('https://sync.example A1', {}))
        expect(settings.hasPending()).toBe(false)
    })

    it("lets the account's settings go when that account ends here, and no other's ending", () => {
        const { settings } = store()
        settings.set(KEY, 'pk.one')
        settings.delivered('https://sync.example A1', settings.merge('https://sync.example A1', {}))
        settings.accountEnded('https://other.example')
        expect(settings.get(KEY)).toBe('pk.one')
        settings.accountEnded('https://sync.example')
        expect(settings.get(KEY)).toBeUndefined()
        expect(settings.syncedWith()).toBeUndefined()
        // A device that never synced keeps what was set on it.
        settings.set(KEY, 'pk.two')
        settings.accountEnded()
        expect(settings.get(KEY)).toBe('pk.two')
    })

    it('reads only what looks like a setting from a vault', () => {
        expect(readPersonSettings({ a: { value: 'x', changedAt: 1 }, b: { value: 3, changedAt: 1 }, c: { value: null, changedAt: 2 }, d: 'x' })).toEqual({
            a: { value: 'x', changedAt: 1 },
            c: { value: null, changedAt: 2 },
        })
        expect(readPersonSettings(null)).toEqual({})
    })
})
