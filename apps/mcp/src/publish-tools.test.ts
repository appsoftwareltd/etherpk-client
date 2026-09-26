import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { frontmatterIdentity } from '$lib/document/frontmatter/identity'
import { proposeFrontmatter } from '$lib/document/frontmatter/proposal'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { assetNameFromRef, createAssetStore } from '$lib/storage/fs/asset-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { openHeadlessFolder } from './headless-folder'
import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { publishGraphKey, withPublishFolder, writePublishFolders } from './publish-folders'
import { cliPublishOutput, createPublication, findPublication, listPublications, publish, publishingInfo, updatePublication } from './publish-tools'
import { ToolError, readDocument, setAliases, setFrontmatter } from './tools'

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

    // On a synced graph a page's aliases live in the registry, and a block with no `aliases:` line
    // claims none (ADR 0061): a block set_frontmatter adds without them would clear every alias at
    // the next edit to it in the Client.
    it('keeps a page’s aliases in the block set_frontmatter adds', async () => {
        const g = await graph('g-pub-aliases')
        await g.store.createPage('Guide', '- body')
        await g.settle()
        await setAliases(g, { concept: 'Guide', aliases: ['Handbook'] })
        await setFrontmatter(g, { concept: 'Guide', patch: { public: true, publications: ['docs'] } })

        const text = g.store.openRaw('Guide').getText()
        expect(frontmatterIdentity(text).aliases).toEqual(['Handbook'])
        expect(text).toContain('public: true')
        expect(proposeFrontmatter({ text, registry: { kind: 'page', concept: 'Guide', aliases: ['Handbook'] }, backend: 'server' })).toEqual([])
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
        const unknown = await rejectsWith(publish(g, { id: 'nope' }, host), 'publication_not_found')
        expect(unknown.message).toBe('No publication has the id "nope". Its publications: docs. list_publications shows them.')
        // A person at the command line has no agent tool to run.
        const atTheCli = await rejectsWith(findPublication(g, 'nope', { ...host, via: 'cli' }), 'publication_not_found')
        expect(atTheCli.message).toBe('No publication has the id "nope". Its publications: docs. Settings → Publish in EtherPK lists them.')
        expect((await findPublication(g, 'docs', host)).name).toBe('Docs')

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
        expect(files).toEqual(expect.arrayContaining(['index.html', 'guide.html', 'AGENTS.md']))
        // The report comes back as the result and never goes into the site: it names the
        // documents left out, and a static host serves whatever the folder holds.
        expect(files).not.toContain('etherpk-publish.json')
        expect(first).not.toHaveProperty('report')
        for (const name of files.filter((f) => /\.(html|json|xml|js|md)$/.test(f))) {
            expect(await readFile(join(site, name), 'utf8'), name).not.toContain('Private')
        }
        expect(await readFile(join(site, 'index.html'), 'utf8')).toContain('hello from the site')
        expect(await readFile(join(site, 'index.html'), 'utf8')).not.toContain('not public')

        // What the command line prints names no document the site leaves out: a scheduled
        // publish's log can be as public as the site. Links to the private page are counted by
        // status, and warnings keep their codes but not their sentences.
        await g.store.createPage('Linker', '- see [[Private]] and [[Nowhere]]')
        await g.settle()
        await setFrontmatter(g, { concept: 'Linker', patch: { public: true, publications: ['docs'] } })
        const linked = await publish(g, { id: 'docs' }, host)
        expect(linked.missingLinks.first.map((l) => l.concept)).toContain('Private')
        const printed = JSON.stringify(cliPublishOutput(linked))
        expect(printed).not.toContain('Private')
        expect(printed).not.toContain('Nowhere')
        expect(cliPublishOutput(linked).missingLinks).toEqual({ total: 2, byStatus: { private: 1, missing: 1 } })
        expect(cliPublishOutput(linked).included.first).toContain('Linker')

        // Again: nothing changed, so nothing is rewritten.
        const second = await publish(g, { id: 'docs' }, host)
        expect(second.written).toMatchObject({ written: 0, deleted: { total: 0 } })
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
        // Mermaid scopes every rule of its inline <style> to the svg's id; without the id the
        // node rects fall back to SVG's default black fill.
        const svg = /<figure class="diagram diagram-mermaid">(<svg\b[^>]*>)/.exec(html)![1]
        const id = /\sid="([^"]+)"/.exec(svg)?.[1]
        expect(id).toBe('mermaid_index_1')
        const style = /<figure class="diagram diagram-mermaid"><svg\b[^>]*>[\s\S]*?<style\b[^>]*>([\s\S]*?)<\/style>/.exec(html)![1]
        // Selectors only: a colour such as #ECECFF is followed by ; or }, a selector by { or a space.
        const scopes = new Set([...style.matchAll(/#([A-Za-z][\w-]*)(?=[\s{.,>])/g)].map((m) => m[1]))
        expect([...scopes]).toEqual([id])
    }, 60_000)
})
