/**
 * A [[Publish Repository]] before any publish: reading what a person typed as a repository,
 * checking that their GitHub token can reach it, and starting the branch when they ask (ADR 0152).
 *
 * The check runs when the repository is saved in the Publish tab and before the first publish to
 * one that was never checked, rather than behind a button of its own. Write access is proven by
 * writing: a fine-grained token's own permissions are not in any answer GitHub gives (a
 * repository's `permissions` are the person's role), so the check uploads a tiny blob that no
 * commit refers to, which GitHub discards.
 *
 * A publish never creates a branch: a branch name mistyped would publish where no host looks.
 * The person asks for it (`createBranch`), after the check has said the branch is not there.
 */
import { type GitHubApi, GitHubError, type GitHubRepository, branchPath, bytesToBase64, repoPath } from './github-api'

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * `owner/name` from what a person typed or pasted: `owner/name`, a github.com address, a clone
 * url or an ssh address. Null when it is none of those.
 */
export function parseRepository(input: string): { owner: string; name: string } | null {
    const text = input
        .trim()
        .replace(/^git@github\.com:/i, '')
        .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
    const parts = text.split('/')
    if (parts.length !== 2) return null
    const [owner, name] = parts
    if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null
    return { owner, name }
}

/** Whether git takes `name` as a branch name (the rules of `git check-ref-format` a person can break by typing). */
export function isBranchName(name: string): boolean {
    if (name === '' || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
    if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
    // Control characters are refused too, by code rather than in the pattern.
    if ([...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return false
    return !/[\s~^:?*[\\]/.test(name)
}

export type RepositoryCheck =
    /** The token reads the branch and writes to the repository. */
    | { state: 'ready' }
    /** The repository has no commits: Create branch makes its first. */
    | { state: 'empty' }
    /** The repository has commits but not this branch. */
    | { state: 'branch-missing' }

/** Whether the branch is there, read with the token. The repository is read first, so a 404 for the branch means the branch. */
async function branchState(api: GitHubApi, repo: GitHubRepository): Promise<'present' | 'empty' | 'missing'> {
    await api.request('GET', repoPath(repo))
    try {
        await api.request('GET', `${repoPath(repo)}/git/ref/heads/${branchPath(repo.branch)}`)
        return 'present'
    } catch (error) {
        if (error instanceof GitHubError && error.code === 'empty-repository') return 'empty'
        if (error instanceof GitHubError && error.code === 'no-access') return 'missing'
        throw error
    }
}

/** Probe the repository and branch with the token. Refusals throw {@link GitHubError}. */
export async function checkRepository(api: GitHubApi, repo: GitHubRepository): Promise<RepositoryCheck> {
    const branch = await branchState(api, repo)
    if (branch === 'empty') return { state: 'empty' }
    if (branch === 'missing') return { state: 'branch-missing' }
    try {
        await api.request('POST', `${repoPath(repo)}/git/blobs`, { content: 'EtherPK write check\n', encoding: 'utf-8' })
    } catch (error) {
        // GitHub answers 403, or 404 for some tokens, to a write the token may not make.
        if (error instanceof GitHubError && (error.code === 'read-only' || error.code === 'no-access')) {
            throw new GitHubError('read-only', error.message, error.status)
        }
        throw error
    }
    return { state: 'ready' }
}

/**
 * Start `repo.branch` holding only `readme`. In a repository with commits it is a branch of its
 * own, sharing no history with the others, so the site is all it holds. In an empty repository
 * the git database endpoints refuse every call, so the first commit goes through the contents
 * endpoint, which makes it on the branch named.
 */
export async function createBranch(api: GitHubApi, repo: GitHubRepository, readme: string): Promise<void> {
    const base = repoPath(repo)
    const message = 'Start the site'
    const state = await branchState(api, repo)
    if (state === 'present') return
    if (state === 'empty') {
        await api.request('PUT', `${base}/contents/README.md`, { message, content: bytesToBase64(new TextEncoder().encode(readme)), branch: repo.branch })
        return
    }
    const tree = await api.request<{ sha: string }>('POST', `${base}/git/trees`, { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }] })
    const commit = await api.request<{ sha: string }>('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [] })
    await api.request('POST', `${base}/git/refs`, { ref: `refs/heads/${repo.branch}`, sha: commit.sha })
}

function megabytes(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))} MB`
}

function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * An error from a check or a publish, worded for the person: what happened, why, and what to do.
 * `replaceToken` says where a new token goes: the Publish tab's GitHub section by default, an
 * environment variable at the Headless Client's command line.
 */
export function describeGitHubError(error: unknown, repo: GitHubRepository, options: { replaceToken?: string } = {}): string {
    if (!(error instanceof GitHubError)) return error instanceof Error ? error.message : String(error)
    const where = `${repo.owner}/${repo.name}`
    switch (error.code) {
        case 'offline':
            return 'GitHub could not be reached. Check the connection and try again.'
        case 'bad-token':
            return `GitHub refused the token. It has expired, been revoked or was mistyped. ${options.replaceToken ?? 'Make a new one and replace it under GitHub above.'}`
        case 'no-access':
            return `GitHub found no repository ${where} for this token. Check the name, and that the token's Repository access includes it.`
        case 'read-only':
            return `The token can read ${where} but not write to it. On GitHub, give the token the Contents permission with Read and write.`
        case 'branch-missing':
            return `${where} has no branch "${repo.branch}". Check the name, or create the branch.`
        case 'empty-repository':
            return `${where} is empty. Create the branch to make its first commit.`
        case 'branch-moved':
            return `The branch "${repo.branch}" changed twice while EtherPK was publishing to it. Publish again.`
        case 'branch-protected':
            return `A protection rule on "${repo.branch}" refused the commit, as it asks for a pull request or a signed commit. Publish to a branch of its own, such as gh-pages, and serve the site from that branch.`
        case 'rate-limited':
            return `GitHub asked EtherPK to wait for longer than it will. Nothing was committed. Publish again after ${clock(error.detail?.retryAt ?? Date.now())}.`
        case 'too-large':
            return `${error.detail?.path ?? 'A file'} is ${megabytes(error.detail?.size ?? 0)}, and GitHub takes files up to 100 MB. Nothing was committed. Make the file smaller or link to it from elsewhere.`
        case 'truncated':
            return `"${repo.branch}" holds more files than GitHub lists at once, so EtherPK cannot see which old files to remove. Publish to a branch of its own.`
        case 'unexpected':
            return `GitHub refused the request${error.status ? ` (${error.status})` : ''}: ${error.message}`
    }
}
