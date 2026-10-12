/**
 * Where each [[Publication]]'s [[Publish Folder]] is on this machine (ADR 0086): configuration a
 * person sets with `etherpk-mcp publish … --out <dir>`, read by the `publish` tool and by the
 * command without `--out`. A file of its own beside the logins (`publish.json`), because it is
 * not a secret and outlives a login; keyed by the graph the way its cache directory is keyed -
 * the server's host and graph id for a synced graph, the folder's path hash for a served folder -
 * so two graphs with a publication both called `blog` never share a folder. Never written into a
 * graph folder, which is the user's content (ADR 0079).
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import nodePath, { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { defaultConfigPath } from './config'
import type { HeadlessBackend } from './headless-graph'
import { folderKey } from './persistence'

export interface PublishFolders {
    /** graph key → publication id → absolute folder path. */
    folders: Record<string, Record<string, string>>
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
    const folders = (parsed as { folders?: unknown } | null)?.folders
    if (typeof folders !== 'object' || folders === null || Array.isArray(folders)) return out
    for (const [graphKey, byPublication] of Object.entries(folders as Record<string, unknown>)) {
        if (typeof byPublication !== 'object' || byPublication === null || Array.isArray(byPublication)) continue
        const kept: Record<string, string> = {}
        for (const [publication, path] of Object.entries(byPublication as Record<string, unknown>)) {
            if (typeof path === 'string' && isAbsolute(path)) kept[publication] = path
        }
        if (Object.keys(kept).length > 0) out.folders[graphKey] = kept
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

/**
 * How a Publish Folder sits against a graph folder: the `same` folder, `inside` it, or it
 * `contains` the graph folder. A publish deletes, from the folder it writes into, the files under
 * `assets/` and `theme/` and the top-level pages it did not produce (`isOwnedPath`), so any of the
 * three would cost the graph files; the Local Mirror refuses the same three for the same reason.
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

/** The same file with one publication's folder set (made absolute) - the caller writes it. */
export function withPublishFolder(folders: PublishFolders, graphKey: string, publicationId: string, folder: string): PublishFolders {
    return {
        folders: {
            ...folders.folders,
            [graphKey]: { ...(folders.folders[graphKey] ?? {}), [publicationId]: resolve(folder) },
        },
    }
}
