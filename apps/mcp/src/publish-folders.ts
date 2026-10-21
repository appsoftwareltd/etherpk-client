/**
 * Where each [[Publication]] publishes from this machine (ADR 0086, ADR 0152): its [[Publish
 * Folder]], set with `etherpk-mcp publish … --out <dir>`, or its [[Publish Repository]], set with
 * `--github owner/name[#branch]`. One or the other: setting one forgets the other, as in the
 * Client. Read by the `publish` tool and by the command run without either. A file of its own
 * beside the logins (`publish.json`), because it is not a secret and outlives a login (the GitHub
 * token is never in it: it comes from `ETHERPK_GITHUB_TOKEN`); keyed by the graph the way its
 * cache directory is keyed - the server's host and graph id for a synced graph, the folder's path
 * hash for a served folder - so two graphs with a publication both called `blog` never share a
 * destination. Never written into a graph folder, which is the user's content (ADR 0079).
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import nodePath, { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { isBranchName, parseRepository } from '$lib/document/publish/host/github-repository'
import type { GitHubRepository } from '$lib/document/publish/host/github-api'

import { defaultConfigPath } from './config'
import type { HeadlessBackend } from './headless-graph'
import { folderKey } from './persistence'

export interface PublishFolders {
    /** graph key → publication id → absolute folder path. */
    folders: Record<string, Record<string, string>>
    /** graph key → publication id → the repository and branch it is committed to. */
    repositories?: Record<string, Record<string, GitHubRepository>>
}

/**
 * `owner/name` or `owner/name#branch` (a github.com address works too), as `--github` takes it.
 * Null when it is not a repository, or the branch is not a name git takes.
 */
export function parseRepositoryArgument(text: string): GitHubRepository | null {
    const [repository, branch, ...rest] = text.trim().split('#')
    if (rest.length > 0) return null
    const parsed = parseRepository(repository)
    const name = branch?.trim() || 'main'
    if (!parsed || !isBranchName(name)) return null
    return { ...parsed, branch: name }
}

/** How a repository is written for a person: `owner/name#branch`. */
export function repositoryLabel(repo: GitHubRepository): string {
    return `${repo.owner}/${repo.name}#${repo.branch}`
}

export function defaultPublishFoldersPath(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.ETHERPK_MCP_PUBLISH_CONFIG?.trim()
    if (override) return override
    return join(dirname(defaultConfigPath(env)), 'publish.json')
}

/** The key a graph's folders are kept under: stable across launches, distinct across graphs. */
export function publishGraphKey(backend: HeadlessBackend, graphId: string): string {
    if (backend.kind === 'folder') return `local/${folderKey(backend.path)}`
    return `${backend.server.replace(/[^A-Za-z0-9.-]/g, '_')}/${graphId}`
}

/** Tolerant of a hand-edited file: keeps the entries it understands. */
export function parsePublishFolders(raw: string): PublishFolders {
    const out: PublishFolders = { folders: {} }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return out
    }
    const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
    const folders = (parsed as { folders?: unknown } | null)?.folders
    if (isMap(folders)) {
        for (const [graphKey, byPublication] of Object.entries(folders)) {
            if (!isMap(byPublication)) continue
            const kept: Record<string, string> = {}
            for (const [publication, path] of Object.entries(byPublication)) {
                if (typeof path === 'string' && isAbsolute(path)) kept[publication] = path
            }
            if (Object.keys(kept).length > 0) out.folders[graphKey] = kept
        }
    }
    const repositories = (parsed as { repositories?: unknown } | null)?.repositories
    if (isMap(repositories)) {
        for (const [graphKey, byPublication] of Object.entries(repositories)) {
            if (!isMap(byPublication)) continue
            const kept: Record<string, GitHubRepository> = {}
            for (const [publication, repo] of Object.entries(byPublication)) {
                if (!isMap(repo) || typeof repo.owner !== 'string' || typeof repo.name !== 'string' || typeof repo.branch !== 'string') continue
                const checked = parseRepositoryArgument(`${repo.owner}/${repo.name}#${repo.branch}`)
                if (checked) kept[publication] = checked
            }
            if (Object.keys(kept).length > 0) (out.repositories ??= {})[graphKey] = kept
        }
    }
    return out
}

export async function readPublishFolders(path: string): Promise<PublishFolders> {
    try {
        return parsePublishFolders(await readFile(path, 'utf8'))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { folders: {} }
        throw error
    }
}

export async function writePublishFolders(path: string, folders: PublishFolders): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(folders, null, 2)}\n`, { mode: 0o600 })
}

/** The folder set for a publication on this machine, or null. */
export function publishFolderOf(folders: PublishFolders, graphKey: string, publicationId: string): string | null {
    return folders.folders[graphKey]?.[publicationId] ?? null
}

/** The repository set for a publication on this machine, or null. */
export function publishRepositoryOf(folders: PublishFolders, graphKey: string, publicationId: string): GitHubRepository | null {
    return folders.repositories?.[graphKey]?.[publicationId] ?? null
}

/** `publications` with one entry dropped, and the graph's map dropped when it empties. */
function without<T>(byGraph: Record<string, Record<string, T>> | undefined, graphKey: string, publicationId: string): Record<string, Record<string, T>> {
    const out = { ...(byGraph ?? {}) }
    const rest = { ...(out[graphKey] ?? {}) }
    delete rest[publicationId]
    if (Object.keys(rest).length > 0) out[graphKey] = rest
    else delete out[graphKey]
    return out
}

/** The same file with one publication's repository set, in place of any folder - the caller writes it. */
export function withPublishRepository(folders: PublishFolders, graphKey: string, publicationId: string, repo: GitHubRepository): PublishFolders {
    const repositories = folders.repositories ?? {}
    return {
        folders: without(folders.folders, graphKey, publicationId),
        repositories: { ...repositories, [graphKey]: { ...(repositories[graphKey] ?? {}), [publicationId]: repo } },
    }
}

/**
 * How a Publish Folder sits against a graph folder: the `same` folder, `inside` it, or it
 * `contains` the graph folder. A publish deletes, from the folder it writes into, the files under
 * `assets/`, `theme/`, `maps/` and `pictures/` and the top-level pages it did not produce
 * (`isOwnedPath`), so any of the three would cost the graph files; the Local Mirror refuses the same three for the same reason.
 */
export type FolderOverlap = 'same' | 'inside' | 'contains'

export interface RelateFoldersOptions {
    /** Compare without case, as the default filesystems of macOS and Windows do. */
    caseInsensitive?: boolean
    /** The platform's path rules; `node:path/win32` in a test of Windows paths. */
    path?: Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'resolve' | 'sep'>
}

/**
 * How two absolute folder paths relate, by the platform's own `relative` rather than by splitting
 * on `/` (Windows paths use `\`, and a shared prefix such as `notes` and `notes-site` is not a
 * parent). Spelling only: {@link publishFolderOverlap} resolves symbolic links first.
 */
export function relateFolders(graphFolder: string, publishFolder: string, options: RelateFoldersOptions = {}): FolderOverlap | null {
    const path = options.path ?? nodePath
    const caseInsensitive = options.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32')
    const fold = (p: string) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p))
    const graph = fold(graphFolder)
    const site = fold(publishFolder)
    // `to` is below `from` when the way there never climbs: not `..` or `../…`, and not another
    // drive's absolute path. A folder named `..notes` is still below.
    const below = (from: string, to: string) => {
        const rel = path.relative(from, to)
        return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    }
    if (path.relative(graph, site) === '') return 'same'
    if (below(graph, site)) return 'inside'
    if (below(site, graph)) return 'contains'
    return null
}

/**
 * A path with its symbolic links resolved, for a folder that may not exist yet: the nearest
 * existing ancestor is resolved and the rest appended, so `--out ./site` under a linked parent is
 * compared where it will really be written.
 */
async function canonicalFolder(folder: string): Promise<string> {
    const absolute = resolve(folder)
    try {
        return await realpath(absolute)
    } catch {
        const parent = dirname(absolute)
        if (parent === absolute) return absolute
        return join(await canonicalFolder(parent), basename(absolute))
    }
}

/** {@link relateFolders} over the folders as they are on disk, symbolic links followed. */
export async function publishFolderOverlap(graphFolder: string, publishFolder: string): Promise<FolderOverlap | null> {
    return relateFolders(await canonicalFolder(graphFolder), await canonicalFolder(publishFolder))
}

/** The same file with one publication's folder set (made absolute), in place of any repository - the caller writes it. */
export function withPublishFolder(folders: PublishFolders, graphKey: string, publicationId: string, folder: string): PublishFolders {
    const repositories = without(folders.repositories, graphKey, publicationId)
    return {
        folders: {
            ...folders.folders,
            [graphKey]: { ...(folders.folders[graphKey] ?? {}), [publicationId]: resolve(folder) },
        },
        ...(Object.keys(repositories).length > 0 ? { repositories } : {}),
    }
}
