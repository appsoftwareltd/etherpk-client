/**
 * Publishing to a [[Publish Repository]] (ADR 0152): a branch of a GitHub repository standing in
 * for the folder, so a publish is one commit that the host watching the branch deploys.
 *
 * The folder's rules are not repeated here. {@link openRepositoryBranch} is a third adapter of
 * the {@link SiteFolder} seam that `writeSite` runs over: it reads the branch's tree once, answers
 * `sameContent` by comparing git's name for a file's content with the tree's (so nothing is
 * downloaded to find what changed), and records writes and removals in memory. `commit` then
 * sends them as one commit: binary files as blobs, text inline in the tree, a removal as a tree
 * entry with no content, and the branch moved only forward.
 *
 * {@link publishToRepository} is the whole publish over that adapter:
 *
 * - **A branch that moved is published again, whole.** When another device or a person pushed
 *   between the read and the commit, GitHub refuses the update. Every decision `writeSite` made
 *   (which seeded files were missing, the AGENTS.md it merged, which files were strays) was
 *   against the old tree, so the publish starts again from the new head rather than replaying
 *   them. Once; a second refusal is reported, with nothing overwritten.
 * - **A branch that is not this site is asked about first.** Unless the branch's AGENTS.md says
 *   it holds this publication's site, a publish that would replace or delete files there returns
 *   them for the person to confirm, and commits nothing.
 * - **A branch that holds a knowledge graph is refused.** The publish would delete its assets.
 *
 * The publish report never enters a request: the bundle never holds it (`runPublish`), and the
 * commit message names only the publication and two counts, because a repository's history is
 * permanent and may be public.
 */
import { publishedPublicationOf } from '../seeded'
import type { SiteBundle, SiteFile } from '../types'
import { gitBlobSha } from './git-blob-sha'
import { type GitHubApi, GitHubError, type GitHubRepository, base64ToBytes, branchPath, bytesToBase64, repoPath } from './github-api'
import { type SiteFolder, type SiteWriteResult, writeSite } from './site-writer'

/** GitHub refuses a file over 100 MiB. */
export const GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024
/** Tree entries sent in one request, and inline text in one request, before the next batch starts. */
const TREE_BATCH_ENTRIES = 300
const TREE_BATCH_BYTES = 4 * 1024 * 1024

interface TreeEntry {
    mode: string
    sha: string
}

export type RepositoryPhase = 'reading' | 'uploading' | 'committing'

export interface CommitOptions {
    onProgress?(phase: RepositoryPhase, done: number, total: number): void
    maxFileBytes?: number
    treeBatch?: number
}

/** A branch read once, as a {@link SiteFolder} whose writes wait in memory for {@link commit}. */
export interface RepositoryBranch extends SiteFolder {
    /** The commit the branch pointed at when it was read. */
    readonly head: string
    /** The files this publish would replace or delete that are on the branch now (AGENTS.md is merged, not replaced). */
    replaced(): string[]
    /** How many files are written or removed so far. */
    pendingChanges(): number
    /** Send what was written as one commit and move the branch to it; null when nothing was. */
    commit(message: string, options?: CommitOptions): Promise<{ sha: string; url: string } | null>
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** Read the branch: its head commit and every file in its tree. */
export async function openRepositoryBranch(api: GitHubApi, repo: GitHubRepository): Promise<RepositoryBranch> {
    const base = repoPath(repo)
    let head: string
    try {
        head = (await api.request<{ object: { sha: string } }>('GET', `${base}/git/ref/heads/${branchPath(repo.branch)}`)).object.sha
    } catch (error) {
        // GitHub answers 404 both for a branch that is not there and for a repository the token
        // cannot see; reading the repository tells them apart.
        if (error instanceof GitHubError && error.code === 'no-access') {
            await api.request('GET', base)
            throw new GitHubError('branch-missing', error.message, error.status)
        }
        throw error
    }
    const treeSha = (await api.request<{ tree: { sha: string } }>('GET', `${base}/git/commits/${head}`)).tree.sha
    const listing = await api.request<{ tree: { path: string; mode: string; type: string; sha: string }[]; truncated: boolean }>('GET', `${base}/git/trees/${treeSha}?recursive=1`)
    // A stray EtherPK cannot see is a stray it cannot remove.
    if (listing.truncated) throw new GitHubError('truncated', 'GitHub listed the branch only in part.')
    const tree = new Map<string, TreeEntry>()
    for (const entry of listing.tree) if (entry.type === 'blob') tree.set(entry.path, { mode: entry.mode, sha: entry.sha })

    /** Path → new content, or null for a removal. */
    const staged = new Map<string, SiteFile | null>()
    const downloaded = new Map<string, Uint8Array>()

    async function bytesAt(path: string): Promise<Uint8Array | null> {
        const change = staged.get(path)
        if (change !== undefined) return change === null ? null : typeof change === 'string' ? encoder.encode(change) : change
        const entry = tree.get(path)
        if (!entry) return null
        let bytes = downloaded.get(entry.sha)
        if (!bytes) {
            const blob = await api.request<{ content: string }>('GET', `${base}/git/blobs/${entry.sha}`)
            bytes = base64ToBytes(blob.content)
            downloaded.set(entry.sha, bytes)
        }
        return bytes
    }

    return {
        head,
        async readText(path) {
            const bytes = await bytesAt(path)
            return bytes === null ? null : decoder.decode(bytes)
        },
        readBytes: bytesAt,
        async sameContent(path, content) {
            const entry = tree.get(path)
            return entry !== undefined && entry.sha === (await gitBlobSha(content))
        },
        async writeFile(path, content) {
            staged.set(path, content)
        },
        async remove(path) {
            // GitHub fails a whole tree that removes a path it does not hold.
            if (tree.has(path)) staged.set(path, null)
        },
        async listFiles() {
            return [...tree.keys()]
        },
        replaced() {
            return [...staged.keys()].filter((path) => tree.has(path) && path !== 'AGENTS.md').sort()
        },
        pendingChanges() {
            return staged.size
        },
        async commit(message, options = {}) {
            if (staged.size === 0) return null
            const report = options.onProgress ?? (() => {})
            const maxFileBytes = options.maxFileBytes ?? GITHUB_MAX_FILE_BYTES
            // Every file is measured before anything is sent, so a refusal leaves the branch untouched.
            for (const [path, content] of staged) {
                if (content === null) continue
                const size = typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength
                if (size > maxFileBytes) throw new GitHubError('too-large', `${path} is over GitHub's file size limit.`, undefined, { path, size })
            }

            // Binary files go up as blobs, one request each, unless GitHub holds that content already.
            const known = new Set([...tree.values()].map((entry) => entry.sha))
            const binaries = [...staged].filter((change): change is [string, Uint8Array] => change[1] instanceof Uint8Array)
            const blobShas = new Map<string, string>()
            report('uploading', 0, binaries.length)
            for (const [index, [path, bytes]] of binaries.entries()) {
                let sha = await gitBlobSha(bytes)
                if (!known.has(sha)) {
                    sha = (await api.request<{ sha: string }>('POST', `${base}/git/blobs`, { content: bytesToBase64(bytes), encoding: 'base64' })).sha
                    known.add(sha)
                }
                blobShas.set(path, sha)
                report('uploading', index + 1, binaries.length)
            }

            const entries = [...staged].map(([path, content]) => {
                const mode = tree.get(path)?.mode ?? '100644'
                if (content === null) return { path, mode, type: 'blob', sha: null }
                if (typeof content === 'string') return { path, mode, type: 'blob', content }
                return { path, mode, type: 'blob', sha: blobShas.get(path) as string }
            })
            const batches = batch(entries, options.treeBatch ?? TREE_BATCH_ENTRIES)
            let root = treeSha
            for (const [index, entriesOfBatch] of batches.entries()) {
                report('committing', index, batches.length + 2)
                root = (await api.request<{ sha: string }>('POST', `${base}/git/trees`, { base_tree: root, tree: entriesOfBatch })).sha
            }
            report('committing', batches.length, batches.length + 2)
            const commit = await api.request<{ sha: string; html_url: string }>('POST', `${base}/git/commits`, { message, tree: root, parents: [head] })
            report('committing', batches.length + 1, batches.length + 2)
            await api.request('PATCH', `${base}/git/refs/heads/${branchPath(repo.branch)}`, { sha: commit.sha, force: false })
            report('committing', batches.length + 2, batches.length + 2)
            return { sha: commit.sha, url: commit.html_url }
        },
    }
}

/** Tree entries in batches small enough for one request: by count, and by the text they carry. */
function batch<T extends { content?: string }>(entries: T[], size: number): T[][] {
    const out: T[][] = []
    let current: T[] = []
    let bytes = 0
    for (const entry of entries) {
        const weight = entry.content?.length ?? 0
        if (current.length > 0 && (current.length >= size || bytes + weight > TREE_BATCH_BYTES)) {
            out.push(current)
            current = []
            bytes = 0
        }
        current.push(entry)
        bytes += weight
    }
    if (current.length > 0) out.push(current)
    return out
}

export interface RepositoryPublishInput {
    publicationId: string
    bundle: SiteBundle
    /** The seeded files for a repository (`seededFiles(publication, 'repository')`). */
    seeded: ReadonlyMap<string, string>
    agentsMd(existing: string | null): string
}

export interface RepositoryPublishOptions extends CommitOptions {
    /** The person agreed to replace the files a first publish listed. */
    confirmed?: boolean
}

export type RepositoryPublishResult =
    | { state: 'committed'; written: SiteWriteResult; commit: { sha: string; url: string }; retried: boolean }
    | { state: 'unchanged'; written: SiteWriteResult }
    /** Nothing was committed: these files on the branch would be replaced or deleted. */
    | { state: 'needs-confirmation'; replaced: string[] }

/** The graph's own AGENTS.md section (`storage/fs/agents-md-section.md`). */
const GRAPH_AGENTS_HEADING = /^## EtherPK knowledge graph\s*$/m

/** True when the branch looks like a [[Graph Folder]], which a publish would gut. */
async function holdsGraph(branch: RepositoryBranch): Promise<boolean> {
    const files = await branch.listFiles()
    if (files.some((path) => path.startsWith('pages/')) && files.some((path) => path.startsWith('journals/'))) return true
    const agents = files.includes('AGENTS.md') ? await branch.readText('AGENTS.md') : null
    return agents !== null && GRAPH_AGENTS_HEADING.test(agents)
}

/** Publish a rendered site to the branch as one commit, under the rules at the top of this module. */
export async function publishToRepository(api: GitHubApi, repo: GitHubRepository, input: RepositoryPublishInput, options: RepositoryPublishOptions = {}): Promise<RepositoryPublishResult> {
    for (let attempt = 0; ; attempt++) {
        options.onProgress?.('reading', 0, 0)
        const branch = await openRepositoryBranch(api, repo)
        if (await holdsGraph(branch)) {
            throw new Error(
                `${repo.owner}/${repo.name} holds a knowledge graph on "${repo.branch}", and a publish there would delete its files. Choose a repository or a branch of its own for the site.`,
            )
        }
        const publishedHere = publishedPublicationOf(await branch.readText('AGENTS.md')) === input.publicationId
        const written = await writeSite(branch, input.bundle, { seeded: input.seeded, agentsMd: input.agentsMd })
        if (!options.confirmed && !publishedHere) {
            const replaced = branch.replaced()
            if (replaced.length > 0) return { state: 'needs-confirmation', replaced }
        }
        if (branch.pendingChanges() === 0) return { state: 'unchanged', written }
        const message = `Publish ${input.publicationId}: ${written.written} written, ${written.deleted.length} removed`
        try {
            const commit = (await branch.commit(message, options)) as { sha: string; url: string }
            return { state: 'committed', written, commit, retried: attempt > 0 }
        } catch (error) {
            if (error instanceof GitHubError && error.code === 'branch-moved' && attempt === 0) continue
            throw error
        }
    }
}
