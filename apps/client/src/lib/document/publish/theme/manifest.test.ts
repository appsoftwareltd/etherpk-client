import { describe, expect, it } from 'vitest'

import { THEME_CONTRACT, layoutFor, parseThemeManifest, themeFileErrors } from './manifest'

describe('parseThemeManifest', () => {
    it('reads a manifest and defaults what it can', () => {
        const { manifest, errors } = parseThemeManifest(JSON.stringify({ name: 'x', contract: 1, includes: [{ name: 'footer', description: 'The footer' }, { name: 'styles', kind: 'css' }] }))
        expect(errors).toEqual([])
        expect(manifest).toEqual({
            name: 'x',
            version: '0.0.0',
            contract: 1,
            kinds: ['docs', 'blog'],
            includes: [
                { name: 'footer', description: 'The footer' },
                { name: 'styles', description: '', kind: 'css' },
            ],
            files: [],
        })
    })

    it('keeps a display title when the manifest gives one, and none otherwise', () => {
        expect(parseThemeManifest(JSON.stringify({ name: 'x', title: '  My Theme ', contract: 1 })).manifest?.title).toBe('My Theme')
        expect(parseThemeManifest(JSON.stringify({ name: 'x', title: '', contract: 1 })).manifest).not.toHaveProperty('title')
    })

    it('refuses a theme written for a newer contract, with the reason', () => {
        const { manifest, errors } = parseThemeManifest(JSON.stringify({ name: 'x', contract: THEME_CONTRACT + 1 }))
        expect(manifest).toBeNull()
        expect(errors[0]).toContain(`contract ${THEME_CONTRACT + 1}`)
    })

    it('needs a name and a contract, and refuses bad JSON', () => {
        expect(parseThemeManifest('{').errors).toEqual(['theme.json is not valid JSON.'])
        expect(parseThemeManifest('{}').errors).toHaveLength(2)
    })

    it('drops file paths that escape the theme', () => {
        const { manifest } = parseThemeManifest(JSON.stringify({ name: 'x', contract: 1, files: ['layouts/page.html', '../etc/passwd', '/abs'] }))
        expect(manifest?.files).toEqual(['layouts/page.html'])
    })
})

describe('layoutFor and themeFileErrors', () => {
    const files = new Map([['layouts/page.html', 'P'], ['partials/footer.html', 'F']])

    it('falls back to the page layout', () => {
        expect(layoutFor(files, 'home')).toBe('P')
        expect(layoutFor(new Map(), 'page')).toBeNull()
    })

    it('insists on the page layout and on a partial per declared html slot', () => {
        const manifest = parseThemeManifest(JSON.stringify({ name: 'x', contract: 1, includes: [{ name: 'footer' }, { name: 'head' }, { name: 'styles', kind: 'css' }] })).manifest!
        expect(themeFileErrors({ manifest, files })).toEqual(['The theme declares the include slot "head" but has no `partials/head.html`.'])
        expect(themeFileErrors({ manifest, files: new Map() })[0]).toContain('layouts/page.html')
    })
})
