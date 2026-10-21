import { describe, expect, it } from 'vitest'

import { GitHubError, createGitHubApi } from './github-api'
import { checkRepository, createBranch, describeGitHubError, isBranchName, parseRepository } from './github-repository'
import { FakeGitHub } from './testing/fake-github'

const repo = { owner: 'someone', name: 'garden-site', branch: 'main' }

function setUp() {
    const github = new FakeGitHub()
    github.allow('good', 'someone/garden-site')
    const api = (token = 'good') => createGitHubApi({ token, fetch: github.fetch, sleep: async () => {} })
    return { github, api }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
    try {
        await work
    } catch (error) {
        return error instanceof GitHubError ? error.code : `not a GitHubError: ${String(error)}`
    }
    return 'no error'
}

describe('parseRepository', () => {
    it('takes owner/name, a GitHub url, a clone url and an ssh address', () => {
        for (const input of ['someone/garden-site', 'https://github.com/someone/garden-site', 'https://github.com/someone/garden-site.git', 'github.com/someone/garden-site/', 'git@github.com:someone/garden-site.git', ' someone/garden-site ']) {
            expect(parseRepository(input), input).toEqual({ owner: 'someone', name: 'garden-site' })
        }
    })

    it('refuses what is not a repository', () => {
        for (const input of ['', 'garden-site', 'someone/', 'some one/garden', 'https://gitlab.com/someone/garden-site', 'someone/garden/site', 'someone/..']) {
            expect(parseRepository(input), input).toBeNull()
        }
    })
})

describe('isBranchName', () => {
    it('takes the names git takes and refuses the rest', () => {
        for (const name of ['main', 'gh-pages', 'site/live', 'v1.2']) expect(isBranchName(name), name).toBe(true)
        for (const name of ['', ' main', 'a b', 'a..b', '/main', 'main/', 'a//b', 'main.lock', 'a~b', 'a:b', 'a@{b']) expect(isBranchName(name), name).toBe(false)
    })
})

describe('checkRepository', () => {
    it('says ready when the token can read the branch and write to the repository', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site', { files: { 'index.html': 'x' } })
        expect(await checkRepository(api(), repo)).toEqual({ state: 'ready' })
    })

    it('says when the repository has no commits yet', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site')
        expect(await checkRepository(api(), repo)).toEqual({ state: 'empty' })
    })

    it('says when the branch does not exist', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site', { files: { 'index.html': 'x' } })
        expect(await checkRepository(api(), { ...repo, branch: 'gh-pages' })).toEqual({ state: 'branch-missing' })
    })

    it('tells a refused token from a repository the token cannot see from one it cannot write to', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site', { files: { 'index.html': 'x' } })
        await github.createRepository('someone/kitchen', { files: { 'index.html': 'x' } })
        github.allow('reader', 'someone/garden-site', 'read')
        expect(await codeOf(checkRepository(api('wrong'), repo))).toBe('bad-token')
        expect(await codeOf(checkRepository(api(), { ...repo, name: 'kitchen' }))).toBe('no-access')
        expect(await codeOf(checkRepository(api('reader'), repo))).toBe('read-only')
    })

    it('says GitHub could not be reached when fetch fails', async () => {
        const api = createGitHubApi({ token: 'good', fetch: async () => Promise.reject(new TypeError('Failed to fetch')), sleep: async () => {} })
        expect(await codeOf(checkRepository(api, repo))).toBe('offline')
    })
})

describe('createBranch', () => {
    it('starts a branch of its own in a repository that has others, holding only the README', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site', { files: { 'src/app.ts': 'code' } })
        await createBranch(api(), { ...repo, branch: 'gh-pages' }, '# Garden\n')
        expect([...github.files('someone/garden-site', 'gh-pages').keys()]).toEqual(['README.md'])
        expect(github.history('someone/garden-site', 'gh-pages')[0].parents).toEqual([])
        expect(github.text('someone/garden-site', 'src/app.ts')).toBe('code')
    })

    it('makes the first commit of an empty repository on the branch', async () => {
        const { github, api } = setUp()
        await github.createRepository('someone/garden-site')
        await createBranch(api(), repo, '# Garden\n')
        expect(github.text('someone/garden-site', 'README.md')).toBe('# Garden\n')
        expect(await checkRepository(api(), repo)).toEqual({ state: 'ready' })
    })
})

describe('describeGitHubError', () => {
    it('says what happened, why and what to do, naming the repository and branch', () => {
        const text = (code: ConstructorParameters<typeof GitHubError>[0], detail?: ConstructorParameters<typeof GitHubError>[3]) =>
            describeGitHubError(new GitHubError(code, 'raw', 400, detail), repo)
        expect(text('bad-token')).toMatch(/token/i)
        expect(text('no-access')).toContain('someone/garden-site')
        expect(text('read-only')).toMatch(/Contents/)
        expect(text('branch-protected')).toMatch(/branch of its own/)
        expect(text('too-large', { path: 'assets/film.mp4', size: 150 * 1024 * 1024 })).toContain('assets/film.mp4')
        expect(text('unexpected')).toContain('raw')
        // Plain UI copy: no em dash, no semicolon.
        for (const code of ['offline', 'bad-token', 'no-access', 'read-only', 'branch-missing', 'empty-repository', 'branch-moved', 'branch-protected', 'rate-limited', 'too-large', 'truncated'] as const) {
            expect(text(code, { retryAt: Date.UTC(2026, 9, 17, 14, 5), path: 'a', size: 1 })).not.toMatch(/[—;]/)
        }
    })

    it('words an error that is not GitHub’s as its own message', () => {
        expect(describeGitHubError(new Error('Something local'), repo)).toBe('Something local')
    })
})
