import { describe, expect, it } from 'vitest'

import { createInMemoryDocumentStore } from '$lib/document/in-memory-store'
import { discoverPublications } from '$lib/document/publish/publication'
import { buildNav } from '$lib/document/publish/nav'
import { SAMPLE_SOURCE } from '$lib/document/publish/sample-graph'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import {
    copyThemeForGraph,
    createPublicationPage,
    freeThemeId,
    setDocumentPublishing,
    setPublicationInclude,
    suggestPublicationId,
    summarisePublishing,
    updatePublicationPage,
} from './publish-service'

describe('setDocumentPublishing', () => {
    it('adds the keys to a document with no block and only rewrites the block', async () => {
        const store = createInMemoryDocumentStore({ Guide: '- body [[X]]\n' })
        expect(await setDocumentPublishing(store, 'Guide', { public: true, publications: ['docs'] })).toBe(true)
        expect(store.open('Guide').getText()).toBe('---\npublic: true\npublications:\n  - docs\n---\n- body [[X]]\n')
        expect(await setDocumentPublishing(store, 'Guide', { public: true, publications: ['docs'] })).toBe(false)
        expect(await setDocumentPublishing(store, 'Guide', { public: null, publications: null })).toBe(true)
        expect(store.open('Guide').getText()).toBe('- body [[X]]\n')
    })
})

describe('createPublicationPage', () => {
    it('creates the page with the mapping and an outline seeded with the home page', async () => {
        const store = createInMemoryDocumentStore()
        const created: string[] = []
        const withCreate = Object.assign(store, {
            async createPage(title: string, body = '') {
                created.push(title)
                store.setText(title, body)
                return title
            },
        })
        const concept = await createPublicationPage(withCreate, { title: 'Docs Site', id: 'docs', kind: 'docs', selection: 'named', home: 'Welcome', url: 'https://docs.example.com' })
        expect(concept).toBe('Docs Site')
        const text = store.open('Docs Site').getText()
        // The page says what it is and how its outline becomes the menu (a paragraph the nav
        // builder skips; 2026-09-19, after a page seeded with one bullet read as an empty page),
        // then the outline, seeded with the home page.
        expect(text.startsWith('---\npublication:\n  id: docs\n  kind: docs\n  selection: named\n  home: Welcome\n  url: https://docs.example.com\n---\n')).toBe(true)
        expect(text).toContain('This page defines the publication')
        expect(text).toContain('Settings → Publish')
        expect(text.endsWith('\n\n- [[Welcome]]\n')).toBe(true)
        const { publications } = discoverPublications([{ concept, kind: 'page', text, aliases: [] }])
        expect(publications[0]).toMatchObject({ id: 'docs', home: 'Welcome', theme: 'etherpk-docs' })
        // The explanation is prose, not a menu entry, and holds no wikilink of its own.
        const nav = buildNav(publications[0].outline, { resolve: (c: string) => ({ href: 'x.html', missing: false, canonical: c, status: 'published' }), slugOf: () => 'x', titleHtml: (c: string) => c } as never)
        expect(nav.nav.map((n) => n.label)).toEqual(['Welcome'])
        expect(nav.issues).toEqual([])
        await expect(createPublicationPage(withCreate, { title: 'X', id: 'Bad Id', kind: 'docs', selection: 'named' })).rejects.toThrow('not a publication id')
    })

    it('refuses a day as the publication\'s name, through the store, and writes nothing', async () => {
        // The publication page is a page, so a day cannot be its name (ADR 0056). The refusal
        // is the store's own, which the Publish tab shows beside the form with the input kept.
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        await expect(createPublicationPage(store, { title: '2026-09-01', id: 'diary', kind: 'blog', selection: 'named' })).rejects.toThrow(
            '“2026-09-01” is a date',
        )
        expect(await adapter.list('pages')).toEqual([])
        expect(await adapter.list('journals')).toEqual([])
    })

    it('suggests an id from a title', () => {
        expect(suggestPublicationId('Docs Site')).toBe('docs-site')
    })
})

describe('updatePublicationPage and setPublicationInclude', () => {
    it('rewrites the mapping, keeping what it did not change', async () => {
        const text = '---\ntitle: Docs Site\npublication:\n  id: docs\n  home: Welcome\n---\n- [[Welcome]]\n'
        const store = createInMemoryDocumentStore({ 'Docs Site': text })
        const current = discoverPublications([{ concept: 'Docs Site', kind: 'page', text, aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', current, { theme: 'my-theme', url: 'https://x.example', home: null })
        let now = store.open('Docs Site').getText()
        expect(now).toBe('---\ntitle: Docs Site\npublication:\n  id: docs\n  kind: docs\n  selection: named\n  theme: my-theme\n  url: https://x.example\n---\n- [[Welcome]]\n')
        const updated = discoverPublications([{ concept: 'Docs Site', kind: 'page', text: now, aliases: [] }]).publications[0]
        await setPublicationInclude(store, 'Docs Site', updated, 'footer', 'Site Footer')
        now = store.open('Docs Site').getText()
        expect(now).toContain('  includes:\n    footer: Site Footer\n')
        const withInclude = discoverPublications([{ concept: 'Docs Site', kind: 'page', text: now, aliases: [] }]).publications[0]
        await setPublicationInclude(store, 'Docs Site', withInclude, 'footer', null)
        expect(store.open('Docs Site').getText()).not.toContain('includes')

        // `recent` is written only when it is not the default, and a change back to the default
        // (or null) removes it; an untouched non-default value survives another edit.
        const cleared = discoverPublications([{ concept: 'Docs Site', kind: 'page', text: store.open('Docs Site').getText(), aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', cleared, { recent: 5 })
        expect(store.open('Docs Site').getText()).toContain('  recent: 5\n')
        const withRecent = discoverPublications([{ concept: 'Docs Site', kind: 'page', text: store.open('Docs Site').getText(), aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', withRecent, { home: 'Welcome' })
        expect(store.open('Docs Site').getText()).toContain('  recent: 5\n')
        const still = discoverPublications([{ concept: 'Docs Site', kind: 'page', text: store.open('Docs Site').getText(), aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', still, { recent: 10 })
        expect(store.open('Docs Site').getText()).not.toContain('recent')
    })

    it('waits for a store that writes on a debounce to land the edit before returning', async () => {
        // The Publish tab re-reads the graph from the folder right after a save; a Filesystem
        // store's autosave window would hand back the page as it was (2026-09-19).
        const text = '---\npublication:\n  id: docs\n---\n- [[Welcome]]\n'
        const inner = createInMemoryDocumentStore({ 'Docs Site': text })
        const flushed: string[] = []
        const store = {
            open: (target: string) => inner.open(target),
            flushDocument: async (target: string) => {
                flushed.push(target)
            },
        }
        const current = discoverPublications([{ concept: 'Docs Site', kind: 'page', text, aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', current, { home: 'Welcome' })
        expect(flushed).toEqual(['Docs Site'])
        expect(inner.open('Docs Site').getText()).toContain('home: Welcome')
    })

    it('writes fields and includes together in one rewrite, a blank include clearing the slot', async () => {
        // The Publish tab saves a card's edits at once, so one write carries every field.
        const text = '---\npublication:\n  id: docs\n  includes:\n    footer: Old Footer\n    head: Analytics\n---\n- [[Welcome]]\n'
        const store = createInMemoryDocumentStore({ 'Docs Site': text })
        const current = discoverPublications([{ concept: 'Docs Site', kind: 'page', text, aliases: [] }]).publications[0]
        await updatePublicationPage(store, 'Docs Site', current, { kind: 'blog', selection: 'all-public', includes: { footer: 'New Footer', head: '', logo: 'Logo' } })
        const now = store.open('Docs Site').getText()
        expect(now).toBe('---\npublication:\n  id: docs\n  kind: blog\n  selection: all-public\n  theme: etherpk-docs\n  includes:\n    footer: New Footer\n    logo: Logo\n---\n- [[Welcome]]\n')
    })
})

describe('summarisePublishing', () => {
    it('describes every document the way the selection reads it, so the tab can say why a named page would be left out', () => {
        const source = {
            ...SAMPLE_SOURCE,
            documents: [
                ...SAMPLE_SOURCE.documents,
                { concept: 'Site Footer', kind: 'page' as const, text: '- footer\n', aliases: ['Footer'] },
                { concept: 'Locked', kind: 'page' as const, text: '---\npublic: true\n---\n```etherpk-cipher\nAQQAAAGYnotreal\n```\n', aliases: [] },
                { concept: 'Blog Home', kind: 'page' as const, text: '---\npublication:\n  id: blog\n---\n- [[Welcome]]\n', aliases: [] },
            ],
        }
        const { documents } = summarisePublishing(source)
        const byName = new Map(documents.map((d) => [d.concept, d]))
        expect(byName.get('Welcome')).toMatchObject({ isPublic: true, publications: [], isProtected: false, isPublicationPage: false })
        expect(byName.get('Site Footer')).toMatchObject({ aliases: ['Footer'], isPublic: false })
        expect(byName.get('Locked')).toMatchObject({ isPublic: true, isProtected: true })
        expect(byName.get('Blog Home')).toMatchObject({ isPublicationPage: true })
    })
})

describe('themes for the graph', () => {
    it('copies a bundled theme with its manifest under a free id', async () => {
        const theme = await copyThemeForGraph('etherpk-docs', 'my-docs', 'My docs', { existingIds: [] })
        expect(theme).toMatchObject({ id: 'my-docs', name: 'My docs', origin: 'etherpk-docs' })
        expect(theme.files['theme.json']).toContain('"etherpk-docs"')
        expect(theme.files['layouts/page.html']).toBeDefined()
        await expect(copyThemeForGraph('etherpk-docs', 'my-docs', 'x', { existingIds: ['my-docs'] })).rejects.toThrow('already has')
        await expect(copyThemeForGraph('nope', 'a', 'x', { existingIds: [] })).rejects.toThrow('No bundled theme')
    })

    it('finds a free id', () => {
        expect(freeThemeId('My Docs', [])).toBe('my-docs')
        expect(freeThemeId('My Docs', ['my-docs', 'my-docs-2'])).toBe('my-docs-3')
    })
})
