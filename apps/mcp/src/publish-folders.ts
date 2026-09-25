/**
 * Where each [[Publication]]'s [[Publish Folder]] is on this machine (ADR 0086): configuration a
 * person sets with `etherpk-mcp publish … --out <dir>`, read by the `publish` tool and by the
 * command without `--out`. A file of its own beside the logins (`publish.json`), because it is
 * not a secret and outlives a login; keyed by the graph the way its cache directory is keyed -
 * the server's host and graph id for a synced graph, the folder's path hash for a served folder -
 * so two graphs with a publication both called `blog` never share a folder. Never written into a
 * graph folder, which is the user's content (ADR 0079).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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

/** The same file with one publication's folder set (made absolute) - the caller writes it. */
export function withPublishFolder(folders: PublishFolders, graphKey: string, publicationId: string, folder: string): PublishFolders {
    return {
        folders: {
            ...folders.folders,
            [graphKey]: { ...(folders.folders[graphKey] ?? {}), [publicationId]: resolve(folder) },
        },
    }
}
