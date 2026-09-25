import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from './memory-adapter'
import { deleteGraphTheme, graphThemeFileText, readGraphThemes, stripJsonComments, themeFileName, themeIdOfFileName, writeGraphTheme } from './theme-files'

const theme = { id: 'my-docs', name: 'My docs', files: { 'theme.json': '{"name":"my-docs","contract":1}', 'layouts/page.html': '<p>{{{page.content}}}</p>' }, origin: 'etherpk-docs' }

describe('theme files', () => {
    it('names the file by the theme id and reads the id back', () => {
        // .jsonc, so the file can open with a comment saying where it is edited (2026-09-19).
        expect(themeFileName('my-docs')).toBe('theme-my-docs.jsonc')
        expect(themeIdOfFileName('theme-my-docs.jsonc')).toBe('my-docs')
        expect(themeIdOfFileName('theme-my-docs.json')).toBeNull()
        expect(themeIdOfFileName('settings.json')).toBeNull()
        expect(themeIdOfFileName('theme-Not Valid.jsonc')).toBeNull()
    })

    it('opens with a comment pointing at the Theme editor, above the theme as JSON', () => {
        const text = graphThemeFileText(theme)
        const lines = text.split('\n')
        expect(lines[0].startsWith('// ')).toBe(true)
        expect(text).toContain('Theme editor')
        expect(text).toContain('docs.etherpk.com/theming-a-published-site')
        // Everything after the comment lines is plain JSON.
        const json = lines.filter((l) => !l.startsWith('//')).join('\n')
        expect(JSON.parse(json)).toEqual(theme)
    })

    it('strips comments outside strings only, so // and /* inside a template survive', () => {
        const inner = { css: 'a { color: red } /* keep */ .b { background: url(//cdn.example/x) }', js: '// not a comment in the data\n"quoted // too"' }
        const text = `// header\n/* block\n   comment */\n${JSON.stringify(inner)} // trailing\n`
        expect(JSON.parse(stripJsonComments(text))).toEqual(inner)
    })

    it('round-trips a theme through etherpk/, sorted by id, and deletes it again', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await writeGraphTheme(adapter, { ...theme, id: 'zed' })
        await writeGraphTheme(adapter, theme)
        expect((await readGraphThemes(adapter)).map((t) => t.id)).toEqual(['my-docs', 'zed'])
        expect((await readGraphThemes(adapter))[0]).toEqual(theme)
        await deleteGraphTheme(adapter, 'zed')
        expect((await readGraphThemes(adapter)).map((t) => t.id)).toEqual(['my-docs'])
    })

    it('skips a malformed file and one whose json names another theme', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', 'theme-broken.jsonc', '{')
        await adapter.write('etherpk', 'theme-other.jsonc', JSON.stringify({ ...theme, id: 'my-docs' }))
        await writeGraphTheme(adapter, theme)
        expect((await readGraphThemes(adapter)).map((t) => t.id)).toEqual(['my-docs'])
    })

    it('reads nothing from a folder without etherpk/', async () => {
        expect(await readGraphThemes(createMemoryDirectoryAdapter({ now: () => 1 }))).toEqual([])
    })
})
