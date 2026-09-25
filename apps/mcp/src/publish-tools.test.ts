import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
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
import { publishGraphKey, withPublishFolder, writePublishFolders } from './publish-folders'
import { createPublication, listPublications, publish, publishingInfo, updatePublication } from './publish-tools'
import { ToolError, readDocument, setFrontmatter } from './tools'

/**
 * The publishing tools over both backends (ADR 0082, 0084, 0086). A publication page an agent
 * creates is the page a person would get from the Settings tab; a publish lands in the folder a
 * person configured and nowhere else; a page with Mermaid publishes through a real browser or
 * not at all.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const open: HeadlessGraph[] = []
let clock = 1_700_000_000_000

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

/** A Chromium to draw with, when this machine has one: the named one, or a `chromium` on the PATH. */
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

    /** A process environment of the test's own: its publish folder file, and no browser unless said. */
    async function hostFor(chromium: string | null = '/nonexistent/chromium') {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-publish-'))
        const env: NodeJS.ProcessEnv = { ...process.env, ETHERPK_MCP_PUBLISH_CONFIG: join(dir, 'publish.json'), ETHERPK_CHROMIUM: chromium ?? '' }
        return { env, dir, host: { env, cmd: 'etherpk-mcp' } }
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

    afterEach(async () => {
        await Promise.all(open.splice(0).map((g) => g.dispose()))
    })

    it('creates a publication as the Settings tab would, lists it, and refuses a taken id or an unknown theme', async () => {
        const g = await graph('g-pub-create')
        const { host } = await hostFor()
        const created = await createPublication(g, { title: 'Project Docs', home: 'Welcome' }, host)
        expect(created.publication).toMatchObject({ id: 'project-docs', name: 'Project Docs', page: 'Project Docs', kind: 'docs', selection: 'named', home: 'Welcome', theme: 'etherpk-docs', publishFolder: null })

        const page = await readDocument(g, 'Project Docs')
        expect(page.text).toContain('This page defines the publication "Project Docs"')
        expect(page.text).toContain('- [[Welcome]]')
        // The definition is the publication tools' to show, not frontmatter the agent edits.
        expect(page.frontmatter).toEqual({})

        const listed = await listPublications(g, host)
        expect(listed.publications.map((p) => p.id)).toEqual(['project-docs'])
        await rejectsWith(createPublication(g, { title: 'Other Docs', id: 'project-docs' }, host), 'already_exists')
        await rejectsWith(createPublication(g, { title: 'Project Docs' }, host), 'already_exists')
        await rejectsWith(createPublication(g, { title: 'Bad', id: 'Not An Id' }, host), 'invalid_argument')
        const refused = await rejectsWith(createPublication(g, { title: 'Themed', theme: 'no-such-theme' }, host), 'invalid_argument')
        expect(refused.message).toContain('No theme is called')
    })

    it('updates settings on the page, and lists the public documents no publication takes', async () => {
        const g = await graph('g-pub-update')
        const { host } = await hostFor()
        await createPublication(g, { title: 'Blog' }, host)
        await g.store.createPage('Footer', 'Made with EtherPK')
        await g.store.createPage('Loose', '- public, in nothing')
        await g.settle()
        await setFrontmatter(g, { concept: 'Footer', patch: { public: true, publications: ['blog'] } })
        await setFrontmatter(g, { concept: 'Loose', patch: { public: true } })

        const updated = await updatePublication(g, { id: 'blog', changes: { kind: 'blog', theme: 'etherpk-blog', url: 'https://blog.example.com', recent: 5, includes: { footer: 'Footer' } } }, host)
        expect(updated.publication).toMatchObject({ kind: 'blog', theme: 'etherpk-blog', url: 'https://blog.example.com', recent: 5, includes: { footer: 'Footer' } })

        const listed = await listPublications(g, host)
        expect(listed.publications[0]).toMatchObject({ id: 'blog', kind: 'blog', recent: 5 })
        expect(listed.publicInNoPublication).toEqual(['Loose'])

        expect((await updatePublication(g, { id: 'blog', changes: { recent: null, url: null, includes: { footer: null } } }, host)).publication).toMatchObject({ recent: 10, url: null, includes: {} })
        await rejectsWith(updatePublication(g, { id: 'nope', changes: { kind: 'blog' } }, host), 'publication_not_found')
        await rejectsWith(updatePublication(g, { id: 'blog', changes: { includes: { footer: 'No Such Page' } } }, host), 'not_found')
    })

    it('publishes into the folder a person set, and nowhere before that', async () => {
        const g = await graph('g-pub-publish')
        const { host, env, dir } = await hostFor()
        await createPublication(g, { title: 'Docs', home: 'Welcome' }, host)
        await g.store.createPage('Welcome', '- hello from the site, see [[Guide]]')
        await g.store.createPage('Guide', '- the guide')
        await g.store.createPage('Private', '- not public')
        await g.settle()
        await setFrontmatter(g, { concept: 'Welcome', patch: { public: true, publications: ['docs'] } })
        await setFrontmatter(g, { concept: 'Guide', patch: { public: true, publications: ['docs'] } })

        const refused = await rejectsWith(publish(g, { id: 'docs' }, host), 'no_publish_folder')
        expect(refused.message).toContain('etherpk-mcp publish')
        expect(refused.message).toContain('--publication docs --out <dir>')
        await rejectsWith(publish(g, { id: 'nope' }, host), 'publication_not_found')

        const site = join(dir, 'site')
        await writePublishFolders(env.ETHERPK_MCP_PUBLISH_CONFIG!, withPublishFolder({ folders: {} }, publishGraphKey(g.backend, g.graphId), 'docs', site))
        expect((await publishingInfo(g, host)).publications).toEqual([{ id: 'docs', name: 'Docs', kind: 'docs', publishFolder: site }])

        const first = await publish(g, { id: 'docs' }, host)
        expect(first.ok).toBe(true)
        expect(first.folder).toBe(site)
        expect(first.included.first.sort()).toEqual(['Guide', 'Welcome'])
        expect(first.excluded.byReason).toMatchObject({ 'not-public': 1, 'publication-page': 1 })
        expect(first.written!.written).toBeGreaterThan(2)
        const files = await readdir(site)
        expect(files).toEqual(expect.arrayContaining(['index.html', 'guide.html', 'etherpk-publish.json', 'AGENTS.md']))
        expect(await readFile(join(site, 'index.html'), 'utf8')).toContain('hello from the site')
        expect(await readFile(join(site, 'index.html'), 'utf8')).not.toContain('not public')

        // Again: nothing changed, so nothing is rewritten but the report, which carries its time.
        const second = await publish(g, { id: 'docs' }, host)
        expect(second.written).toMatchObject({ written: 1, deleted: { total: 0 } })
        expect(second.written!.unchanged).toBeGreaterThan(0)
    })

    it('refuses to publish Mermaid without a browser, and draws it with one', async () => {
        const g = await graph('g-pub-mermaid')
        const none = await hostFor()
        await createPublication(g, { title: 'Docs', home: 'Flow' }, none.host)
        await g.store.createPage('Flow', '- a diagram\n\n```mermaid\nflowchart LR\n  A --> B\n```\n')
        await g.settle()
        await setFrontmatter(g, { concept: 'Flow', patch: { public: true, publications: ['docs'] } })
        const key = publishGraphKey(g.backend, g.graphId)
        await writePublishFolders(none.env.ETHERPK_MCP_PUBLISH_CONFIG!, withPublishFolder({ folders: {} }, key, 'docs', join(none.dir, 'site')))

        const refused = await rejectsWith(publish(g, { id: 'docs' }, none.host), 'chromium_unavailable')
        expect(refused.message).toContain('diagrams setup')
        expect(existsSync(join(none.dir, 'site', 'index.html'))).toBe(false)

        const chromium = chromiumOnThisMachine()
        if (!chromium) {
            console.warn('no Chromium on this machine: the render half of this test did not run (set ETHERPK_CHROMIUM)')
            return
        }
        const drawn = await hostFor(chromium)
        await writePublishFolders(drawn.env.ETHERPK_MCP_PUBLISH_CONFIG!, withPublishFolder({ folders: {} }, key, 'docs', join(drawn.dir, 'site')))
        const result = await publish(g, { id: 'docs' }, drawn.host)
        expect(result.ok).toBe(true)
        expect(result.warnings.map((w) => w.code)).not.toContain('mermaid-unrendered')
        const html = await readFile(join(drawn.dir, 'site', 'index.html'), 'utf8')
        expect(html).toContain('<svg')
        expect(html).toContain('role="img"')
    }, 60_000)
})
