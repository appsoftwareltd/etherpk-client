/**
 * What the asset tools need from a graph's [[Asset]]s, behind one seam for both backends
 * ([[2026-09-20 Headless Client Assets Rename And Publishing]], ADR 0085). The store is the
 * client's own `AssetStore` - the encrypted one over the Sync Server's asset API on a synced
 * graph, the `assets/` directory on a folder - so an agent's upload is named, deduplicated and
 * (on a synced graph) encrypted exactly as a person's is. What differs per backend is only how a
 * reference names an asset (`identify`), which is what the index is asked about when the tools
 * decide whether an asset is reachable from a document the agent can read.
 */

import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { defaultConfigPath } from './config'
import { within } from './local-folders'
import { cacheRoot } from './persistence'

export interface HeadlessAssets {
    store: AssetStore
    /**
     * The identity a reference names on this backend - the file name on a folder, the random id
     * on a synced graph - or null for a reference that is not an asset's (a remote image, a
     * wikilink). The same forms the index counts references by (`assetUsage`).
     */
    identify(ref: string): string | null
    /** Bytes the graph holds per identity, when the backend can say cheaply; absent otherwise. */
    sizes?(): Promise<Map<string, number>>
    /** Where `read_asset` writes when the agent names no directory. */
    downloadsDir: string
    /**
     * Identities this session uploaded. An upload is readable back until a document references
     * it, which is the one exception to "reachable from a readable document" (ADR 0085): the
     * agent that just added it plainly has it.
     */
    uploaded: Set<string>
}

/**
 * The largest file `upload_asset` reads. The Sync Server applies its own, usually smaller, limit;
 * this one bounds what a single call can pull into memory whatever the backend.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export interface LocalFileRules {
    /** Where the Headless Client's config and cache are, as the CLI finds them. */
    env: NodeJS.ProcessEnv
    /** This graph's downloads directory, whose files came from the graph and may go back in. */
    downloadsDir: string
}

async function realOrResolved(path: string): Promise<string> {
    try {
        return await realpath(path)
    } catch {
        return resolve(path)
    }
}

/**
 * Refuse a file an agent should not be able to put into a graph. The path is a tool argument, and
 * an agent can be steered by what it reads, so an upload is a way to copy a local file somewhere
 * collaborators can read it. Refused: the Headless Client's cache (the graph's decrypted
 * contents) and config (sign-in tokens), and anything hidden (a dot-file, or a file inside a
 * dot-folder such as `.ssh` or `.aws`), which is where credentials and settings live. `real` has
 * every link resolved, so a link is judged by the file it leads to.
 */
async function refuseProtected(path: string, real: string, rules: LocalFileRules): Promise<void> {
    if (within(await realOrResolved(rules.downloadsDir), real)) return
    if (within(await realOrResolved(cacheRoot(rules.env)), real)) {
        throw new Error(`${path} is in the Headless Client's cache, which holds the graph's decrypted contents.`)
    }
    const configFile = await realOrResolved(defaultConfigPath(rules.env))
    const configDir = await realOrResolved(dirname(defaultConfigPath({ ...rules.env, ETHERPK_MCP_CONFIG: undefined })))
    if (real === configFile || within(configDir, real)) {
        throw new Error(`${path} is the Headless Client's config, which holds its sign-in tokens.`)
    }
    const hidden = real.split(sep).find((part) => part.startsWith('.'))
    if (hidden) {
        throw new Error(`${path} is hidden (${hidden}), where credentials and settings are kept. Copy it to an ordinary folder to upload it.`)
    }
}

/** A local file as `upload_asset` reads it: an ordinary file, not refused above, within the size limit. */
export async function readLocalFile(path: string, rules: LocalFileRules): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
    const real = await realpath(path)
    await refuseProtected(path, real, rules)
    const info = await stat(real)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (info.size > MAX_UPLOAD_BYTES) throw new Error(`${path} is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB.`)
    const buffer = await readFile(real)
    // A fresh ArrayBuffer-backed copy: the store hands the bytes to crypto and to fetch, which
    // want a plain Uint8Array<ArrayBuffer>, not a slice of Node's pooled buffer.
    const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength))
    bytes.set(buffer)
    return { name: basename(path), bytes }
}

/** Names Windows reserves for devices, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const MAX_NAME_LENGTH = 120

/**
 * A file name for an asset's stored name. The stored name is metadata any collaborator can set,
 * so it is reduced to one plain file: the last path segment, letters, digits, marks, spaces and
 * `. _ - ( )` kept and everything else replaced, no leading dot (so never hidden, never `..`),
 * no trailing dot or space (Windows drops them), not a Windows device name, and short.
 */
export function downloadName(name: string): string {
    const last = name.split(/[\\/]/).pop() ?? ''
    let safe = last
        .replace(/[^\p{L}\p{M}\p{N} ._()-]/gu, '_')
        .replace(/^[.\s]+/, '')
        .replace(/[.\s]+$/, '')
    if (safe === '') return 'asset'
    if (RESERVED.test(safe.split('.')[0]!)) safe = `_${safe}`
    const chars = Array.from(safe)
    if (chars.length <= MAX_NAME_LENGTH) return safe
    const dot = safe.lastIndexOf('.')
    const ext = dot > 0 && safe.length - dot <= 20 ? safe.slice(dot) : ''
    return Array.from(safe.slice(0, safe.length - ext.length)).slice(0, MAX_NAME_LENGTH - ext.length).join('') + ext
}

/** Whether `path` is an ordinary file (not a link) holding exactly `bytes`. */
async function holds(path: string, bytes: Uint8Array): Promise<boolean> {
    const info = await lstat(path)
    if (!info.isFile() || info.size !== bytes.byteLength) return false
    return (await readFile(path)).equals(bytes)
}

/**
 * Write an asset's bytes under `directory`, named by {@link downloadName}, and never over
 * anything already there: the write fails rather than replace a file or follow a link left in
 * its place, and the next candidate is tried. A second asset that shares a display name lands
 * beside the first with a suffix, so an agent reading two `diagram.png`s from two pages gets
 * both; the same bytes again answer the file already written.
 */
export async function writeDownload(directory: string, name: string, bytes: Uint8Array): Promise<string> {
    await mkdir(directory, { recursive: true })
    const safe = downloadName(name)
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    for (let n = 1; n <= 1000; n += 1) {
        const candidate = join(directory, n === 1 ? safe : `${stem}-${n}${ext}`)
        try {
            // `wx` is O_CREAT | O_EXCL: it fails on any existing entry, a dangling link included.
            await writeFile(candidate, bytes, { flag: 'wx' })
            return candidate
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        if (await holds(candidate, bytes)) return candidate
    }
    throw new Error(`${directory} already holds a thousand files named like ${safe}.`)
}
