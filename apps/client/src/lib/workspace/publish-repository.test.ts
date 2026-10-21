import { describe, expect, it } from 'vitest'

import { GitHubError } from '$lib/document/publish/host/github-api'
import { FakeGitHub } from '$lib/document/publish/host/testing/fake-github'
import { createPersonSettings } from '$lib/person-settings/person-settings'

import { GITHUB_TOKEN_SETTING, NO_TOKEN_MESSAGE, checkWithToken, gitHubApiFor, gitHubTokenControls, requireReady } from './publish-repository'

const repo = { owner: 'someone', name: 'garden-site', branch: 'main' }

function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index] ?? null,
        removeItem: (key) => void map.delete(key),
        setItem: (key, value) => void map.set(key, value),
    }
}

describe('the GitHub token controls', () => {
    it('keep one token among the person’s settings, say whether it is set and never what it is', () => {
        const settings = createPersonSettings(() => memoryStorage())
        const token = gitHubTokenControls(settings)
        let heard = 0
        token.subscribe(() => heard++)
        expect(token.read()).toEqual({ set: false, follows: false })
        token.save('  github_pat_garden  ')
        expect(settings.get(GITHUB_TOKEN_SETTING)).toBe('github_pat_garden')
        expect(token.read()).toEqual({ set: true, follows: false })
        token.forget()
        expect(token.read().set).toBe(false)
        expect(heard).toBe(2)
    })

    it('forget the token as a cleared setting, so the clearing reaches the other devices', () => {
        const settings = createPersonSettings(() => memoryStorage())
        const token = gitHubTokenControls(settings)
        token.save('github_pat_garden')
        token.forget()
        expect(settings.all()[GITHUB_TOKEN_SETTING]?.value).toBeNull()
        expect(settings.hasPending()).toBe(true)
    })

    it('sit outside every extension’s keys', () => {
        expect(GITHUB_TOKEN_SETTING.startsWith('extension')).toBe(false)
    })
})

describe('checkWithToken', () => {
    it('is unchecked with no token, and asks for one before a publish', async () => {
        const settings = createPersonSettings(() => memoryStorage())
        expect(await checkWithToken({ settings }, repo)).toBe('unchecked')
        expect(() => gitHubApiFor({ settings })).toThrow(NO_TOKEN_MESSAGE)
        expect(() => requireReady('unchecked', repo)).toThrow(NO_TOKEN_MESSAGE)
    })

    it('checks with the token and words a refusal for the person, keeping its code', async () => {
        const github = new FakeGitHub()
        github.allow('github_pat_garden', 'someone/garden-site', 'read')
        await github.createRepository('someone/garden-site', { files: { 'index.html': 'x' } })
        const settings = createPersonSettings(() => memoryStorage())
        settings.set(GITHUB_TOKEN_SETTING, 'github_pat_garden')
        const error = await checkWithToken({ settings, fetch: github.fetch }, repo).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(GitHubError)
        expect((error as GitHubError).code).toBe('read-only')
        expect((error as GitHubError).message).toContain('Read and write')
    })

    it('stops a publish at a branch that is not there, so the tab can offer to create it', () => {
        for (const [state, code] of [
            ['empty', 'empty-repository'],
            ['branch-missing', 'branch-missing'],
        ] as const) {
            try {
                requireReady(state, repo)
                throw new Error('no refusal')
            } catch (error) {
                expect((error as GitHubError).code).toBe(code)
                expect((error as GitHubError).message).toContain('someone/garden-site')
            }
        }
        expect(() => requireReady('ready', repo)).not.toThrow()
    })
})
