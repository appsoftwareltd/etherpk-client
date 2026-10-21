import { describe, expect, it } from 'vitest'

import { agentsMdWithManagedSection, seededFiles } from '../seeded'
import type { Publication } from '../types'
import { GitHubError, createGitHubApi } from './github-api'
import { type RepositoryPublishInput, publishToRepository } from './github-site-folder'
import { FakeGitHub } from './testing/fake-github'

const publication: Publication = { id: 'garden', name: 'Garden', concept: 'Garden Site', kind: 'docs', selection: 'named', theme: 'etherpk-docs', recent: 10, includes: {}, outline: '' }
const repo = { owner: 'someone', name: 'garden-site', branch: 'main' }
const FULL = 'someone/garden-site'

function site(files: Record<string, string | Uint8Array>): RepositoryPublishInput {
    return {
        publicationId: publication.id,
        bundle: new Map(Object.entries(files)),
        seeded: seededFiles(publication, 'repository'),
        agentsMd: (existing) => agentsMdWithManagedSection(existing, publication),
    }
}

async function setUp(files?: Record<string, string | Uint8Array>) {
    const github = new FakeGitHub()
    github.allow('good', FULL)
    await github.createRepository(FULL, { files: files ?? { 'README.md': '# Garden\n' } })
    const waits: number[] = []
    const waitedUntil: number[] = []
    let clock = 0
    const api = (token = 'good') =>
        createGitHubApi({
            token,
            fetch: github.fetch,
            sleep: async (ms) => {
                waits.push(ms)
                clock += ms
            },
            now: () => clock,
            onWait: (until) => waitedUntil.push(until),
        })
    const posts = (path: string) => github.requests.filter((r) => r.method === 'POST' && r.path.endsWith(path))
    return { github, api, waits, waitedUntil, posts }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
    try {
        await work
    } catch (error) {
        return error instanceof GitHubError ? error.code : `not a GitHubError: ${(error as Error).message}`
    }
    return 'no error'
}

const confirmed = { confirmed: true }

describe('publishToRepository', () => {
    it('commits the site as one commit, text inline and the seeded files with it, and no workflow', async () => {
        const { github, api, posts } = await setUp()
        const result = await publishToRepository(api(), repo, site({ 'index.html': '<h1>Garden</h1>', 'search.json': '[]', '.nojekyll': '' }))
        expect(result.state).toBe('committed')
        const files = github.files(FULL)
        expect([...files.keys()].sort()).toEqual(['.assetsignore', '.gitignore', '.nojekyll', 'AGENTS.md', 'README.md', 'index.html', 'search.json', 'wrangler.jsonc'])
        expect(github.text(FULL, 'README.md')).toBe('# Garden\n')
        expect(github.history(FULL)).toHaveLength(2)
        // Text travels inside the tree: no blob upload for it.
        expect(posts('/git/blobs')).toHaveLength(0)
        expect(posts('/git/commits')).toHaveLength(1)
        if (result.state !== 'committed') return
        expect(result.commit.url).toBe(`https://github.com/${FULL}/commit/${result.commit.sha}`)
        expect(github.history(FULL)[0].message).toBe('Publish garden: 7 written, 0 removed')
    })

    it('makes no commit when nothing changed', async () => {
        const { github, api } = await setUp()
        await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))
        const result = await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))
        expect(result.state).toBe('unchanged')
        expect(github.history(FULL)).toHaveLength(2)
    })

    it('removes strays from the owned places and leaves everything else on the branch alone', async () => {
        const { github, api } = await setUp()
        await publishToRepository(api(), repo, site({ 'index.html': 'v1', 'old.html': 'gone soon', 'assets/old.png': new Uint8Array([1]) }))
        await github.push(FULL, 'main', { CNAME: 'garden.example', 'notes/plan.txt': 'mine' })
        const result = await publishToRepository(api(), repo, site({ 'index.html': 'v2' }))
        expect(result.state).toBe('committed')
        const files = github.files(FULL)
        expect(files.has('old.html')).toBe(false)
        expect(files.has('assets/old.png')).toBe(false)
        expect(github.text(FULL, 'CNAME')).toBe('garden.example')
        expect(github.text(FULL, 'notes/plan.txt')).toBe('mine')
        expect(github.history(FULL)[0].message).toBe('Publish garden: 1 written, 2 removed')
    })

    it('uploads a binary file once, and never again while it is unchanged', async () => {
        const { github, api, posts } = await setUp()
        const logo = new Uint8Array([137, 80, 78, 71, 0, 255])
        await publishToRepository(api(), repo, site({ 'index.html': 'v1', 'assets/logo.png': logo }))
        expect(posts('/git/blobs')).toHaveLength(1)
        await publishToRepository(api(), repo, site({ 'index.html': 'v2', 'assets/logo.png': logo, 'assets/logo-copy.png': logo }))
        // The copy has the same content, so the same name: GitHub has it already.
        expect(posts('/git/blobs')).toHaveLength(1)
        expect(github.files(FULL).get('assets/logo-copy.png')).toEqual(logo)
    })

    it('sends a large site as several trees, each built on the last', async () => {
        const { github, api, posts } = await setUp()
        const files: Record<string, string> = {}
        for (let i = 0; i < 25; i++) files[`page-${i}.html`] = `<p>${i}</p>`
        await publishToRepository(api(), repo, site(files), { treeBatch: 10 })
        expect(posts('/git/trees').length).toBeGreaterThanOrEqual(3)
        expect(github.text(FULL, 'page-24.html')).toBe('<p>24</p>')
        expect(github.history(FULL)).toHaveLength(2)
    })

    it('spaces its writes a second apart', async () => {
        const { api, waits } = await setUp()
        await publishToRepository(api(), repo, site({ 'index.html': 'v1', 'assets/a.png': new Uint8Array([1]), 'assets/b.png': new Uint8Array([2]) }))
        // Blob, blob, tree, commit, ref: four waits between five writes, none longer than the spacing.
        expect(waits.filter((ms) => ms > 0)).toHaveLength(4)
        expect(Math.max(...waits)).toBeLessThanOrEqual(1000)
    })

    describe('when the branch moves under it', () => {
        it('publishes again from the new head, keeping what the other push changed', async () => {
            const { github, api } = await setUp()
            await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))
            github.beforeNextRefUpdate(async () => {
                const agents = github.text(FULL, 'AGENTS.md') as string
                await github.push(FULL, 'main', { CNAME: 'garden.example', 'AGENTS.md': `# Notes of mine\n\n${agents}` })
            })
            const result = await publishToRepository(api(), repo, site({ 'index.html': 'v2' }))
            expect(result).toMatchObject({ state: 'committed', retried: true })
            expect(github.text(FULL, 'index.html')).toBe('v2')
            expect(github.text(FULL, 'CNAME')).toBe('garden.example')
            // The AGENTS.md written was merged with the moved branch's, not the one first read.
            expect(github.text(FULL, 'AGENTS.md')).toContain('# Notes of mine')
        })

        it('reports a branch that moves again, having committed nothing', async () => {
            const { github, api } = await setUp()
            // Moved before the first attempt's update, and again before the second's.
            github.beforeNextRefUpdate(async () => {
                await github.push(FULL, 'main', { 'first.txt': 'x' })
                github.beforeNextRefUpdate(async () => void (await github.push(FULL, 'main', { 'second.txt': 'x' })))
            })
            expect(await codeOf(publishToRepository(api(), repo, site({ 'index.html': 'v1' })))).toBe('branch-moved')
            expect(github.text(FULL, 'index.html')).toBeNull()
        })
    })

    describe('before it replaces files on a branch that is not this site', () => {
        it('asks first, naming what would go, and commits nothing until asked again', async () => {
            const { github, api } = await setUp({ 'index.html': 'their page', 'assets/photo.png': new Uint8Array([9]), 'src/app.ts': 'code' })
            const result = await publishToRepository(api(), repo, site({ 'index.html': 'ours' }))
            expect(result).toEqual({ state: 'needs-confirmation', replaced: ['assets/photo.png', 'index.html'] })
            expect(github.history(FULL)).toHaveLength(1)
            const again = await publishToRepository(api(), repo, site({ 'index.html': 'ours' }), confirmed)
            expect(again.state).toBe('committed')
            expect(github.text(FULL, 'src/app.ts')).toBe('code')
        })

        it('does not ask where this publication was published before', async () => {
            const { api } = await setUp({ 'old.html': 'x', 'AGENTS.md': agentsMdWithManagedSection(null, publication) })
            expect((await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))).state).toBe('committed')
        })

        it('asks where another publication was published', async () => {
            const { api } = await setUp({ 'old.html': 'x', 'AGENTS.md': agentsMdWithManagedSection(null, { ...publication, id: 'kitchen' }) })
            expect((await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))).state).toBe('needs-confirmation')
        })

        it('does not ask when nothing would be replaced', async () => {
            const { api } = await setUp({ 'src/app.ts': 'code' })
            expect((await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))).state).toBe('committed')
        })

        it('refuses a branch that holds a knowledge graph, even when asked', async () => {
            const graphAgents = '<!-- etherpk:start -->\n## EtherPK knowledge graph\n\nnotes\n<!-- etherpk:end -->\n'
            const branches: Record<string, string>[] = [{ 'AGENTS.md': graphAgents }, { 'pages/Garden.md': '# Garden', 'journals/2026_10_17.md': '- water the beans' }]
            for (const files of branches) {
                const { github, api } = await setUp(files)
                await expect(publishToRepository(api(), repo, site({ 'index.html': 'v1' }), confirmed)).rejects.toThrow(/knowledge graph/)
                expect(github.history(FULL)).toHaveLength(1)
            }
        })
    })

    describe('refusals', () => {
        it('names a bad token, a repository it cannot see, and one it can only read', async () => {
            const { github, api } = await setUp()
            github.allow('reader', FULL, 'read')
            expect(await codeOf(publishToRepository(api('wrong'), repo, site({ 'index.html': 'v1' })))).toBe('bad-token')
            expect(await codeOf(publishToRepository(api(), { ...repo, name: 'kitchen' }, site({ 'index.html': 'v1' })))).toBe('no-access')
            expect(await codeOf(publishToRepository(api('reader'), repo, site({ 'index.html': 'v1' })))).toBe('read-only')
        })

        it('names a missing branch and an empty repository, which a publish never creates', async () => {
            const { github, api } = await setUp()
            expect(await codeOf(publishToRepository(api(), { ...repo, branch: 'gh-pages' }, site({ 'index.html': 'v1' })))).toBe('branch-missing')
            expect(github.hasBranch(FULL, 'gh-pages')).toBe(false)
            await github.createRepository('someone/empty')
            github.allow('good', 'someone/empty')
            expect(await codeOf(publishToRepository(api(), { ...repo, name: 'empty' }, site({ 'index.html': 'v1' })))).toBe('empty-repository')
        })

        it('names branch protection', async () => {
            const { github, api } = await setUp()
            github.protect(FULL, 'main')
            expect(await codeOf(publishToRepository(api(), repo, site({ 'index.html': 'v1' })))).toBe('branch-protected')
        })

        it('waits out a rate limit for as long as GitHub asks, and says until when', async () => {
            const { github, api, waits, waitedUntil } = await setUp()
            github.rateLimitWrites(2, 30)
            const result = await publishToRepository(api(), repo, site({ 'index.html': 'v1' }))
            expect(result.state).toBe('committed')
            expect(waits.filter((ms) => ms === 30_000)).toHaveLength(2)
            expect(waitedUntil).toHaveLength(2)
        })

        it('refuses a branch GitHub lists only in part', async () => {
            const { github, api } = await setUp()
            github.truncateTrees = true
            expect(await codeOf(publishToRepository(api(), repo, site({ 'index.html': 'v1' })))).toBe('truncated')
        })

        it('refuses a file over the size limit before it sends anything', async () => {
            const { github, api } = await setUp()
            const before = github.requests.filter((r) => r.method !== 'GET').length
            const error = await publishToRepository(api(), repo, site({ 'index.html': 'v1', 'assets/film.mp4': new Uint8Array(2048) }), { maxFileBytes: 1024 }).catch((e: unknown) => e)
            expect(error).toBeInstanceOf(GitHubError)
            expect((error as GitHubError).code).toBe('too-large')
            expect((error as GitHubError).detail?.path).toBe('assets/film.mp4')
            expect(github.requests.filter((r) => r.method !== 'GET').length).toBe(before)
        })
    })

    it('reports its progress by phase', async () => {
        const { api } = await setUp()
        const phases = new Set<string>()
        await publishToRepository(api(), repo, site({ 'index.html': 'v1', 'assets/a.png': new Uint8Array([1]) }), { onProgress: (phase) => phases.add(phase) })
        expect([...phases]).toEqual(['reading', 'uploading', 'committing'])
    })
})
