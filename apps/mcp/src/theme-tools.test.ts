import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { assetNameFromRef, createAssetStore } from '$lib/storage/fs/asset-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { openHeadlessFolder } from './headless-folder'
import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { createPublication, listPublications, updatePublication } from './publish-tools'
import { createTheme, customisePublicationTheme, deleteTheme, deleteThemeFile, importThemeFolder, listThemes, previewTheme, readTheme, readThemeFile, writeThemeFile } from './theme-tools'
import { ToolError, setFrontmatter } from './tools'

/**
 * The theme tools over both backends: the loop an agent runs to change the look of a published
 * site - make the publication's theme its own, read the files out, write one back, preview,
 * with the worked example the plan named (an analytics script in the head of every page).
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const open: HeadlessGraph[] = []
let clock = 1_700_000_000_000
const ANALYTICS = '<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>'

const backends: Array<[string, (id: string) => Promise<HeadlessGraph>]> = [
    [
        'synced',
        async (id) => {
            const relay = createLoopbackRelay()
            return openHeadlessGraph({
                graphId: `${id}-${Math.floor(performance.now() * 1000)}`,
                rootDocId: ROOT,
                keyring: createGraphKeyring(id),
                relayUrl: 'ws://loopback/sync',
                token: fixedSyncToken('t'),
                presenceName: 'Agent on test',
                connect: relay.connect,
                assets: { store: createAssetStore(createMemoryDirectoryAdapter({ now: () => (clock += 1000) })), identify: assetNameFromRef },
            })
        },
    ],
    [
        'folder',
        (id) =>
            openHeadlessFolder({
                adapter: createMemoryDirectoryAdapter({ now: () => (clock += 1000) }),
                name: id,
                path: `/graphs/${id}`,
                graphId: `${id}-${Math.floor(performance.now() * 1000)}`,
            }),
    ],
]

function chromiumOnThisMachine(): string | null {
    const named = process.env.ETHERPK_CHROMIUM?.trim() || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim()
    if (named && existsSync(named)) return named
    try {
        const found = execSync('command -v chromium || command -v chromium-browser || command -v google-chrome', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return found && existsSync(found) ? found : null
    } catch {
        return null
    }
}

describe.each(backends)('%s backend', (_name, openGraph) => {
    async function graph(id: string): Promise<HeadlessGraph> {
        const g = await openGraph(id)
        open.push(g)
        return g
    }

    async function rejectsWith(promise: Promise<unknown>, code: ToolError['code']): Promise<ToolError> {
        try {
            await promise
        } catch (error) {
            expect(error).toBeInstanceOf(ToolError)
            expect((error as ToolError).code).toBe(code)
            return error as ToolError
        }
        throw new Error(`expected a ToolError(${code})`)
    }

    /** A blog publication on the bundled blog theme with one public post. */
    async function blog(id: string): Promise<HeadlessGraph> {
        const g = await graph(id)
        await createPublication(g, { title: 'Blog', kind: 'blog', theme: 'etherpk-blog' })
        await g.store.createPage('First Post', '- hello from the first post')
        await g.settle()
        await setFrontmatter(g, { concept: 'First Post', patch: { public: true, publications: ['blog'], date: '2026-06-01' } })
        return g
    }

    afterEach(async () => {
        await Promise.all(open.splice(0).map((g) => g.dispose()))
    })

    it('lists the bundled themes as read-only and the graph\'s own as editable, with who uses them', async () => {
        const g = await blog('g-themes-list')
        const before = await listThemes(g)
        expect(before.bundled.map((t) => t.name)).toEqual(expect.arrayContaining(['etherpk-blog', 'etherpk-docs']))
        expect(before.bundled.every((t) => t.editable === false && t.files.includes('theme.json'))).toBe(true)
        expect(before.graph).toEqual([])

        const made = await customisePublicationTheme(g, { publication: 'blog' })
        expect(made).toMatchObject({ created: true, publication: 'blog', theme: { id: 'blog-theme', editable: true, origin: 'etherpk-blog', usedBy: ['blog'], errors: [] } })
        expect((await listPublications(g)).publications[0]!.theme).toBe('blog-theme')
        // Asked again, it is already the graph's own: nothing to copy.
        expect(await customisePublicationTheme(g, { publication: 'blog' })).toMatchObject({ created: false, theme: { id: 'blog-theme' } })
        const after = await listThemes(g)
        expect(after.graph.map((t) => t.id)).toEqual(['blog-theme'])
        await rejectsWith(customisePublicationTheme(g, { publication: 'nope' }), 'publication_not_found')
    })

    it('reads a theme out to disk, writes one file back, and the analytics script reaches every page of the preview', async () => {
        const g = await blog('g-themes-edit')
        await customisePublicationTheme(g, { publication: 'blog' })
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-theme-'))

        const bundled = await readTheme(g, { ref: 'etherpk-blog', out_dir: 'bundled' })
        expect(bundled).toMatchObject({ source: 'bundled', editable: false })
        expect(bundled.note).toContain('cannot be edited in place')
        const own = await readTheme(g, { ref: 'blog-theme', out_dir: 'own' })
        expect(own).toMatchObject({ source: 'graph', editable: true, id: 'blog-theme' })
        expect(own.files.map((f) => f.path)).toEqual(expect.arrayContaining(['theme.json', 'layouts/page.html', 'partials/head.html']))
        expect(await readFile(join(own.folder, 'partials', 'head.html'), 'utf8')).toBe((await readThemeFile(g, { ref: 'blog-theme', path: 'partials/head.html' })).text)

        // The worked example: the tracking script in the head partial.
        const head = (await readThemeFile(g, { ref: 'blog-theme', path: 'partials/head.html' })).text
        expect(await writeThemeFile(g, { id: 'blog-theme', path: 'partials/head.html', text: `${head}\n${ANALYTICS}\n` })).toMatchObject({ id: 'blog-theme', path: 'partials/head.html', errors: [] })
        expect((await readThemeFile(g, { ref: 'blog-theme', path: 'partials/head.html' })).text).toContain('plausible.io')

        const preview = await previewTheme(g, { publication: 'blog', out_dir: 'preview' })
        expect(preview).toMatchObject({ theme: 'blog-theme', publication: 'blog', sample: false, ok: true })
        expect(preview.pages).toContain('first-post.html')
        for (const page of ['index.html', 'first-post.html']) expect(await readFile(join(preview.folder, page), 'utf8')).toContain(ANALYTICS)

        // A bundled theme is never written; a path outside the theme's places is refused.
        await rejectsWith(writeThemeFile(g, { id: 'etherpk-blog', path: 'partials/head.html', text: 'x' }), 'theme_not_editable')
        await rejectsWith(writeThemeFile(g, { id: 'blog-theme', path: '../escape.html', text: 'x' }), 'invalid_argument')
        await rejectsWith(writeThemeFile(g, { id: 'nope', path: 'partials/head.html', text: 'x' }), 'theme_not_found')
        await rejectsWith(readThemeFile(g, { ref: 'blog-theme', path: 'partials/none.html' }), 'not_found')
        await rm(dir, { recursive: true, force: true })
    })

    it('reports a theme broken by a write, and brings an edited folder back whole', async () => {
        const g = await blog('g-themes-validate')
        await customisePublicationTheme(g, { publication: 'blog' })
        const broken = await deleteThemeFile(g, { id: 'blog-theme', path: 'layouts/page.html' })
        expect(broken.errors.join(' ')).toContain('layouts/page.html')
        expect((await writeThemeFile(g, { id: 'blog-theme', path: 'theme.json', text: '{not json' })).errors.length).toBeGreaterThan(0)

        // Repair from a folder: read the bundled original out, edit it there, import it whole.
        const { folder: dir } = await readTheme(g, { ref: 'etherpk-blog', out_dir: 'import-source' })
        await writeFile(join(dir, 'partials', 'head.html'), `${await readFile(join(dir, 'partials', 'head.html'), 'utf8')}\n${ANALYTICS}\n`)
        await writeFile(join(dir, 'notes.txt'), 'not a theme file, skipped')
        const imported = await importThemeFolder(g, { id: 'blog-theme', dir })
        expect(imported.errors).toEqual([])
        expect(imported.files).toContain('layouts/page.html')
        expect(imported.files).not.toContain('notes.txt')
        expect((await readThemeFile(g, { ref: 'blog-theme', path: 'partials/head.html' })).text).toContain('plausible.io')
        await rm(dir, { recursive: true, force: true })
    })

    it('copies any theme into the graph, previews the sample site, and deletes only an unused theme', async () => {
        const g = await blog('g-themes-copy')
        const created = await createTheme(g, { from: 'etherpk-docs', id: 'my-docs', name: 'My Docs' })
        expect(created.theme).toMatchObject({ id: 'my-docs', name: 'My Docs', origin: 'etherpk-docs', usedBy: [], errors: [] })
        const copy = await createTheme(g, { from: 'my-docs' })
        expect(copy.theme.id).toBe('my-docs-2')
        await rejectsWith(createTheme(g, { from: 'etherpk-docs', id: 'my-docs' }), 'already_exists')
        await rejectsWith(createTheme(g, { from: 'no-such-theme' }), 'theme_not_found')
        await rejectsWith(createTheme(g, { from: 'etherpk-docs', id: 'Bad Id' }), 'invalid_argument')

        const sample = await previewTheme(g, { theme: 'my-docs' })
        const dir = sample.folder
        expect(sample).toMatchObject({ theme: 'my-docs', sample: true, ok: true })
        expect(sample.pages.length).toBeGreaterThan(3)
        expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain('<html')
        await rejectsWith(previewTheme(g, { theme: 'nope' }), 'theme_not_found')
        await rejectsWith(previewTheme(g, {}), 'invalid_argument')

        await updatePublication(g, { id: 'blog', changes: { theme: 'my-docs' } })
        const refused = await rejectsWith(deleteTheme(g, { id: 'my-docs' }), 'theme_in_use')
        expect(refused.message).toContain('"Blog"')
        await updatePublication(g, { id: 'blog', changes: { theme: 'etherpk-blog' } })
        expect(await deleteTheme(g, { id: 'my-docs' })).toEqual({ id: 'my-docs', deleted: true })
        expect(await deleteTheme(g, { id: 'my-docs-2' })).toEqual({ id: 'my-docs-2', deleted: true })
        expect((await listThemes(g)).graph).toEqual([])
        await rejectsWith(deleteTheme(g, { id: 'etherpk-docs' }), 'theme_not_editable')
        await rm(dir, { recursive: true, force: true })
    })

    it('writes and reads theme folders only under the downloads directory, and never through a link', async () => {
        const g = await blog('g-themes-confined')
        await customisePublicationTheme(g, { publication: 'blog' })
        const outside = await mkdtemp(join(tmpdir(), 'etherpk-mcp-theme-outside-'))

        await rejectsWith(readTheme(g, { ref: 'etherpk-blog', out_dir: outside }), 'invalid_argument')
        await rejectsWith(readTheme(g, { ref: 'etherpk-blog', out_dir: '../escaped' }), 'invalid_argument')
        await rejectsWith(previewTheme(g, { publication: 'blog', out_dir: outside }), 'invalid_argument')
        // A folder outside is not read back into the graph, even one shaped like a theme.
        await writeFile(join(outside, 'theme.json'), '{"name":"x","contract":1}')
        await rejectsWith(importThemeFolder(g, { id: 'blog-theme', dir: outside }), 'invalid_argument')

        // Inside, a symbolic link is skipped rather than followed to what it points at.
        const { folder } = await readTheme(g, { ref: 'blog-theme', out_dir: 'linked' })
        await writeFile(join(outside, 'secret.html'), 'SECRET')
        await symlink(join(outside, 'secret.html'), join(folder, 'partials', 'linked.html'))
        const imported = await importThemeFolder(g, { id: 'blog-theme', dir: folder })
        expect(imported.files).not.toContain('partials/linked.html')
        await rejectsWith(readThemeFile(g, { ref: 'blog-theme', path: 'partials/linked.html' }), 'not_found')
        await rm(outside, { recursive: true, force: true })
    })

    it('photographs the preview when a browser is available, and says so when none is', async () => {
        const g = await blog('g-themes-shots')
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-theme-shots-'))
        const none = await previewTheme(g, { publication: 'blog', out_dir: 'none', screenshots: true }, { env: { ...process.env, ETHERPK_CHROMIUM: '/nonexistent/chromium' } })
        expect(none.screenshots).toBeNull()
        expect(none.note).toContain('diagrams setup')

        const chromium = chromiumOnThisMachine()
        if (!chromium) {
            console.warn('no Chromium on this machine: the screenshot half of this test did not run (set ETHERPK_CHROMIUM)')
            return
        }
        const shot = await previewTheme(g, { publication: 'blog', out_dir: 'shots', screenshots: true }, { env: { ...process.env, ETHERPK_CHROMIUM: chromium } })
        expect(shot.screenshots).toHaveLength(4)
        for (const s of shot.screenshots!) {
            const png = await readFile(s.path)
            expect(png.subarray(1, 4).toString()).toBe('PNG')
        }
        expect(shot.screenshots!.map((s) => s.width)).toEqual([1280, 390, 1280, 390])
        await rm(dir, { recursive: true, force: true })
    }, 60_000)
})
