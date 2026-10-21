/**
 * The workspace's side of a [[Publish Repository]] (ADR 0152), apart from the publish itself
 * (`publishTo` in `GraphWorkspace.svelte`, which runs it as an Activity): the person's GitHub
 * token, the check a saved repository gets, and errors worded for the Publish tab.
 *
 * The token is one per person, kept in their settings under {@link GITHUB_TOKEN_SETTING}, so it
 * follows them to their other devices through the [[Settings Vault]], which no agent token can
 * read (ADR 0148). The repository is per device (`publication-destination-idb.ts`). The tab is
 * told whether a token is set, never what it is.
 */
import { type GitHubApi, GitHubError, type GitHubRepository, createGitHubApi } from '$lib/document/publish/host/github-api'
import { checkRepository, describeGitHubError } from '$lib/document/publish/host/github-repository'
import type { PersonSettings } from '$lib/person-settings/person-settings'
import type { GitHubTokenState, RepositoryCheckState } from '$lib/sync/ui/publish-tab'

/** Where the person's GitHub token is kept among their settings: a core key, outside every extension's prefix. */
export const GITHUB_TOKEN_SETTING = 'publish.github.token'

/** Worded to make sense in the Publish tab and in a notice from Alt+Shift+P alike. */
export const NO_TOKEN_MESSAGE = 'Set a GitHub token first, under GitHub at the top of Settings → Publish.'

export interface GitHubAccess {
    settings: PersonSettings
    /** Injected by tests; the page's own `fetch` otherwise. */
    fetch?: typeof fetch
}

/** An API client with the person's token, or an error saying to set one. */
export function gitHubApiFor(access: GitHubAccess, onWait?: (until: number) => void): GitHubApi {
    const token = access.settings.get(GITHUB_TOKEN_SETTING)
    if (!token) throw new Error(NO_TOKEN_MESSAGE)
    return createGitHubApi({ token, fetch: access.fetch, onWait })
}

/**
 * A GitHub refusal worded for the person, keeping its code so the tab can act on it (offer
 * Create branch, mark the token as refused). Anything else passes through.
 */
export function personFacing(error: unknown, repo: GitHubRepository): unknown {
    if (!(error instanceof GitHubError)) return error
    return new GitHubError(error.code, describeGitHubError(error, repo), error.status, error.detail)
}

/** Check a repository with the person's token: `unchecked` when there is none to check with. */
export async function checkWithToken(access: GitHubAccess, repo: GitHubRepository): Promise<RepositoryCheckState> {
    if (!access.settings.get(GITHUB_TOKEN_SETTING)) return 'unchecked'
    try {
        return (await checkRepository(gitHubApiFor(access), repo)).state
    } catch (error) {
        throw personFacing(error, repo)
    }
}

/**
 * Stop before a publish to a repository that is not ready, worded for the person: no token, or
 * a branch that is not there yet (which a publish never creates, so the tab offers to).
 */
export function requireReady(state: RepositoryCheckState, repo: GitHubRepository): void {
    if (state === 'unchecked') throw new Error(NO_TOKEN_MESSAGE)
    if (state === 'empty') throw personFacing(new GitHubError('empty-repository', 'empty'), repo)
    if (state === 'branch-missing') throw personFacing(new GitHubError('branch-missing', 'missing'), repo)
}

/** The token controls the Publish tab gets: whether one is set, and setting or forgetting it. */
export function gitHubTokenControls(settings: PersonSettings) {
    return {
        read: (): GitHubTokenState => ({ set: settings.get(GITHUB_TOKEN_SETTING) !== undefined, follows: settings.syncedWith() !== undefined }),
        save: (token: string) => settings.set(GITHUB_TOKEN_SETTING, token.trim()),
        // Cleared rather than removed, so the clearing reaches the person's other devices too.
        forget: () => settings.set(GITHUB_TOKEN_SETTING, null),
        subscribe: (listener: () => void) => settings.subscribe(listener),
    }
}
