import { afterEach, describe, expect, it } from 'vitest'

import { PRESENCE_PALETTE, presenceIdentity } from './presence-identity'

/** A minimal localStorage stand-in for node. */
function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial))
    const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
    }
    ;(globalThis as { localStorage?: unknown }).localStorage = storage
    return store
}

afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('presenceIdentity', () => {
    it('mints a named, coloured identity and keeps it stable across calls', () => {
        stubStorage()
        const first = presenceIdentity()
        expect(first.name).toMatch(/^\w+ \w+$/)
        expect(first.color).toMatch(/^#[0-9a-f]{6}$/)
        expect(first.colorLight).toMatch(/^#[0-9a-f]{8}$/)
        // The identity is the device's, not the call's.
        expect(presenceIdentity()).toEqual(first)
    })

    it('re-mints a stored colour that is not in the palette, keeping the name', () => {
        // A device that minted under an earlier palette: the allocator can only de-duplicate
        // palette entries, so the colour moves onto the palette while the pseudonym stays.
        const store = stubStorage({
            'etherpk.presence-identity': JSON.stringify({ name: 'Swift Toad', color: '#2563eb', colorLight: '#2563eb33' }),
        })
        const identity = presenceIdentity()
        expect(identity.name).toBe('Swift Toad')
        expect(PRESENCE_PALETTE.map((entry) => entry.color)).toContain(identity.color)
        expect(JSON.parse(store.get('etherpk.presence-identity')!)).toEqual(identity)
    })

    it('replaces corrupt storage rather than failing', () => {
        stubStorage({ 'etherpk.presence-identity': '{not json' })
        const identity = presenceIdentity()
        expect(identity.name.length).toBeGreaterThan(0)
    })

    it('still answers when storage is unavailable entirely', () => {
        // No localStorage at all (node, storage-denied private mode).
        const identity = presenceIdentity()
        expect(identity.name.length).toBeGreaterThan(0)
        expect(identity.color).toMatch(/^#/)
    })
})
