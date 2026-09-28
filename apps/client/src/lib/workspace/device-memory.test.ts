import { describe, expect, it } from 'vitest'

import { readAddFrontmatterKeys, readLastPublication, readSettingsTab, writeAddFrontmatterKeys, writeLastPublication, writeSettingsTab } from './device-memory'

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

describe('the Settings modal remembers its last tab per graph', () => {
    it('reads back what was written, per graph, and nothing for an unknown graph', () => {
        const storage = fakeStorage()
        expect(readSettingsTab('g1', storage)).toBeNull()
        writeSettingsTab('g1', 'publish', storage)
        writeSettingsTab('g2', 'mirror', storage)
        expect(readSettingsTab('g1', storage)).toBe('publish')
        expect(readSettingsTab('g2', storage)).toBe('mirror')
    })

    it('ignores a value that is not a tab, and survives a blocked store', () => {
        const storage = fakeStorage()
        storage.setItem('etherpk-settings-tab:g1', 'nonsense')
        expect(readSettingsTab('g1', storage)).toBeNull()
        const blocked = {
            getItem: () => {
                throw new Error('blocked')
            },
            setItem: () => {
                throw new Error('blocked')
            },
        } as unknown as Storage
        expect(readSettingsTab('g1', blocked)).toBeNull()
        expect(() => writeSettingsTab('g1', 'general', blocked)).not.toThrow()
    })
})

describe('the last publication published from this device, per graph', () => {
    it('reads back the id written, and forgets on blank', () => {
        const storage = fakeStorage()
        expect(readLastPublication('g1', storage)).toBeNull()
        writeLastPublication('g1', 'docs', storage)
        expect(readLastPublication('g1', storage)).toBe('docs')
        writeLastPublication('g1', '', storage)
        expect(readLastPublication('g1', storage)).toBeNull()
    })
})

describe('the keys last chosen in the Add frontmatter dialog, per graph', () => {
    it('defaults to the keys most documents use, and reads back the last choice', () => {
        const storage = fakeStorage()
        expect(readAddFrontmatterKeys('g1', storage)).toEqual(['title', 'aliases', 'public', 'publications'])
        writeAddFrontmatterKeys('g1', ['slug', 'date'], storage)
        expect(readAddFrontmatterKeys('g1', storage)).toEqual(['slug', 'date'])
        expect(readAddFrontmatterKeys('g2', storage)).toEqual(['title', 'aliases', 'public', 'publications'])
    })

    it('keeps only keys the dialog knows', () => {
        const storage = fakeStorage()
        storage.setItem('etherpk-add-frontmatter-keys:g1', 'slug,nonsense,title')
        expect(readAddFrontmatterKeys('g1', storage)).toEqual(['title', 'slug'])
    })
})
