import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from './memory-adapter'
import {
    DEFAULT_IMAGE_DISPLAY_SIZE,
    DEFAULT_RECENT_COUNT,
    IMAGE_DISPLAY_SIZE_OFF,
    imageDisplaySizeOf,
    normalizeHexColor,
    readGraphSettings,
    recentCountOf,
    writeGraphSettings,
} from './graph-settings'

const clock = () => {
    let t = 1000
    return () => (t += 1)
}

describe('graph settings', () => {
    it('reads empty defaults when no settings file exists', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        expect(await readGraphSettings(adapter)).toEqual({})
    })

    it('writes to etherpk/settings.json and round-trips', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeGraphSettings(adapter, { defaultMaxImageDisplaySize: '300' })

        expect((await adapter.list('etherpk')).map((e) => e.name)).toEqual(['settings.json'])
        expect(await readGraphSettings(adapter)).toEqual({ defaultMaxImageDisplaySize: '300' })
    })

    it('resolves the upload display size: default when absent, off when 0, else the setting', () => {
        expect(imageDisplaySizeOf({})).toBe(DEFAULT_IMAGE_DISPLAY_SIZE)
        expect(imageDisplaySizeOf({ defaultMaxImageDisplaySize: IMAGE_DISPLAY_SIZE_OFF })).toBeUndefined()
        expect(imageDisplaySizeOf({ defaultMaxImageDisplaySize: '640x480' })).toBe('640x480')
    })

    it('keeps the OFF value through a round-trip so opting out survives a reload', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeGraphSettings(adapter, { defaultMaxImageDisplaySize: IMAGE_DISPLAY_SIZE_OFF })
        expect(await readGraphSettings(adapter)).toEqual({ defaultMaxImageDisplaySize: IMAGE_DISPLAY_SIZE_OFF })
    })

    it('drops unknown / wrong-typed fields on read and write', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ defaultMaxImageDisplaySize: 300, junk: true }))
        // numeric value is not a string ⇒ ignored; unknown key dropped
        expect(await readGraphSettings(adapter)).toEqual({})
    })

    it('reads empty defaults from a malformed file rather than throwing', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', 'settings.json', 'not json{')
        expect(await readGraphSettings(adapter)).toEqual({})
    })

    it('drops the retired indentSize key: the Indent Unit is fixed (ADR 0067)', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ indentSize: 4, defaultCodeLanguage: 'ts' }))
        expect(await readGraphSettings(adapter)).toEqual({ defaultCodeLanguage: 'ts' })
    })

    it('keeps and trims a non-empty defaultCodeLanguage, drops an empty one', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ defaultCodeLanguage: ' ts ' }))
        expect(await readGraphSettings(adapter)).toEqual({ defaultCodeLanguage: 'ts' })
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ defaultCodeLanguage: '   ' }))
        expect(await readGraphSettings(adapter)).toEqual({})
    })

    it('bounds recentDocumentCount and drops nonsense', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        for (const value of [20, 1, 50]) {
            await adapter.write('etherpk', 'settings.json', JSON.stringify({ recentDocumentCount: value }))
            expect(await readGraphSettings(adapter)).toEqual({ recentDocumentCount: value })
        }
        for (const value of [0, -3, 51, 10.5, '10', null]) {
            await adapter.write('etherpk', 'settings.json', JSON.stringify({ recentDocumentCount: value }))
            expect(await readGraphSettings(adapter)).toEqual({})
        }
    })

    it('defaults the Recents count when unset', () => {
        expect(recentCountOf({})).toBe(DEFAULT_RECENT_COUNT)
        expect(recentCountOf({ recentDocumentCount: 25 })).toBe(25)
    })

    it('round-trips favourites in order, deduped case-insensitively', async () => {
        // Favourites are shared graph content (ADR 0036): they live here so they travel in
        // an Export and sync to every device.
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeGraphSettings(adapter, { favourites: ['Recipes', 'Physics'] })
        expect(await readGraphSettings(adapter)).toEqual({ favourites: ['Recipes', 'Physics'] })

        await adapter.write(
            'etherpk',
            'settings.json',
            JSON.stringify({ favourites: ['Physics', 'physics', ' ', 42, 'Recipes'] }),
        )
        // First spelling wins: the entry already on the list keeps its place and its casing,
        // exactly as re-favouriting it does.
        expect(await readGraphSettings(adapter)).toEqual({ favourites: ['Physics', 'Recipes'] })
    })

    it('keeps the NEWEST favourites when the list is over the cap', async () => {
        // The cap exists so a runaway client cannot bloat shared graph content, and new
        // favourites are appended - so it has to bite at the front. Truncating the tail
        // would silently swallow the favourite the user just added on the next read.
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const many = Array.from({ length: 205 }, (_, i) => `Page ${i}`)
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ favourites: many }))

        const kept = (await readGraphSettings(adapter)).favourites
        expect(kept).toHaveLength(200)
        expect(kept?.at(0)).toBe('Page 5')
        expect(kept?.at(-1)).toBe('Page 204')
    })

    it('drops a non-array favourites field rather than throwing', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', 'settings.json', JSON.stringify({ favourites: 'Physics' }))
        expect(await readGraphSettings(adapter)).toEqual({})
    })
    it('canonicalises toolbarColor to lowercase #rrggbb and drops anything else', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        for (const [raw, expected] of [
            ['#1E90FF', '#1e90ff'],
            [' #abc ', '#aabbcc'],
            ['#abcdef', '#abcdef'],
        ]) {
            await adapter.write('etherpk', 'settings.json', JSON.stringify({ toolbarColor: raw }))
            expect(await readGraphSettings(adapter)).toEqual({ toolbarColor: expected })
        }
        for (const raw of ['red', 'rgb(1,2,3)', '#12345', '#1e90ff80', '', 42, null]) {
            await adapter.write('etherpk', 'settings.json', JSON.stringify({ toolbarColor: raw }))
            expect(await readGraphSettings(adapter)).toEqual({})
        }
    })

    it('normalizeHexColor: shorthand expands, case folds, everything else is null', () => {
        expect(normalizeHexColor('#FFF')).toBe('#ffffff')
        expect(normalizeHexColor('#A1b2C3')).toBe('#a1b2c3')
        expect(normalizeHexColor('a1b2c3')).toBeNull()
        expect(normalizeHexColor('#gggggg')).toBeNull()
    })
})
