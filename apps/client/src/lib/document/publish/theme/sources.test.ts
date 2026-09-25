import { describe, expect, it } from 'vitest'

import { bundledThemeList, bundledThemeNames, bundledThemeTitle } from '@appsoftwareltd/etherpk-themes'

import { graphThemeFromFiles, sanitizeGraphTheme, themeFilesOf } from './graph-theme'
import { createThemeLoader, fetchTheme } from './sources'

describe('createThemeLoader', () => {
    it('loads a bundled theme by name', async () => {
        expect(bundledThemeNames()).toEqual(['etherpk-al-folio', 'etherpk-blog', 'etherpk-docs', 'etherpk-papermod', 'etherpk-stack', 'etherpk-terminal'])
        const loaded = await createThemeLoader({})('etherpk-docs')
        expect(loaded.source).toBe('bundled')
        expect(loaded.theme.manifest.name).toBe('etherpk-docs')
        expect(loaded.theme.manifest.title).toBe('EtherPK Docs')
        expect(loaded.theme.files.has('layouts/page.html')).toBe(true)
        expect(loaded.theme.files.has('theme.json')).toBe(false)
    })

    it('gives every bundled theme a display title, for the pickers', () => {
        // The name is the identifier a publication writes; the title is what a person reads.
        expect(bundledThemeTitle('etherpk-blog')).toBe('EtherPK Blog')
        expect(bundledThemeTitle('etherpk-al-folio')).toBe('EtherPK al-folio')
        expect(bundledThemeTitle('no-such-theme')).toBe('no-such-theme')
        expect(bundledThemeList().map((t) => t.title)).toEqual(['EtherPK al-folio', 'EtherPK Blog', 'EtherPK Docs', 'EtherPK PaperMod', 'EtherPK Stack', 'EtherPK Terminal'])
    })

    it('prefers a graph theme of the same id over a bundled one', async () => {
        const graph = graphThemeFromFiles('etherpk-docs', 'Mine', new Map([['theme.json', '{"name":"mine","contract":1}'], ['layouts/page.html', 'X']]), 'etherpk-docs')
        const loaded = await createThemeLoader({ graphTheme: async (id) => (id === 'etherpk-docs' ? graph : null) })('etherpk-docs')
        expect(loaded.source).toBe('graph')
        expect(loaded.theme.manifest.name).toBe('mine')
    })

    it('fetches a url theme, every listed file relative to the manifest', async () => {
        const served = new Map<string, string>([
            ['https://x.example/t/theme.json', '{"name":"remote","contract":1,"files":["layouts/page.html","assets/theme.css"]}'],
            ['https://x.example/t/layouts/page.html', 'PAGE'],
            ['https://x.example/t/assets/theme.css', 'CSS'],
        ])
        const fetchText = async (url: string) => {
            const text = served.get(url)
            if (text === undefined) throw new Error(`404 ${url}`)
            return text
        }
        const loaded = await createThemeLoader({ fetchText })('https://x.example/t/theme.json')
        expect(loaded.source).toBe('url')
        expect([...loaded.theme.files.keys()]).toEqual(['layouts/page.html', 'assets/theme.css'])
        await expect(fetchTheme('https://x.example/missing.json', fetchText)).rejects.toThrow('could not be fetched')
    })

    it('names the reason when nothing answers to the reference', async () => {
        await expect(createThemeLoader({})('nope')).rejects.toThrow('No theme is called "nope"')
        await expect(createThemeLoader({})('https://x.example/theme.json')).rejects.toThrow('cannot fetch')
    })
})

describe('graph themes', () => {
    it('sanitises a stored theme, dropping files outside the theme', () => {
        const theme = sanitizeGraphTheme({ id: 'mine', files: { 'layouts/page.html': 'P', '../etc/passwd': 'x', 'assets/a.css': 'c', 'theme.json': '{}', nested: 3 } })
        expect(theme).toEqual({ id: 'mine', name: 'mine', files: { 'layouts/page.html': 'P', 'assets/a.css': 'c', 'theme.json': '{}' } })
        expect(sanitizeGraphTheme({ id: 'Not Valid' })).toBeNull()
        expect(sanitizeGraphTheme('x')).toBeNull()
    })

    it('refuses a graph theme without a usable manifest', () => {
        expect(() => themeFilesOf({ id: 'a', name: 'A', files: {} })).toThrow('no theme.json')
        expect(() => themeFilesOf({ id: 'a', name: 'A', files: { 'theme.json': '{"name":"a","contract":99}' } })).toThrow('contract 99')
    })
})
