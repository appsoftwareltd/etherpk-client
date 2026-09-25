/**
 * Writing a [[Published Site]] to a folder the user picked (ADR 0082). In the browser the folder
 * is a File System Access API handle; the Headless Client writes the same site through Node's
 * `fs`. The rules are one function over a small {@link SiteFolder} seam, so the two hosts cannot
 * drift ([[2026-09-20 Headless Client Assets Rename And Publishing]]); the handle adapter is
 * here because the site nests (`assets/`, `theme/`, `.github/workflows/`) and the
 * `DirectoryAdapter` is deliberately flat over a graph's four subdirectories.
 *
 * The folder's rules: **owned** paths - every file the publisher produced, and anything under
 * `assets/` and `theme/`, top-level `.html`, `search.json`, `sitemap.xml`, `feed.xml` and the
 * report - are rewritten and their strays deleted; **seeded** files are written when absent and
 * never touched again; `AGENTS.md` has its managed section rewritten and the user's text kept;
 * everything else (`CNAME`, `robots.txt`, `.git/`, a file the user added) is never written or
 * deleted. Only what changed is written, so a publish that changes one page moves one mtime.
 */

import type { SiteBundle, SiteFile } from '../types'

export interface SiteWriteOptions {
    /** Path → text, written only when the file does not exist. */
    seeded: ReadonlyMap<string, string>
    /** The AGENTS.md text for what the folder holds now (null when there is none). */
    agentsMd(existing: string | null): string
    onProgress?(done: number, total: number): void
}

export interface SiteWriteResult {
    written: number
    unchanged: number
    deleted: string[]
}

/**
 * What a host has to offer for a site folder. Paths are relative, `/`-separated, and may nest;
 * `writeFile` creates the directories a path needs. `readText`/`readBytes` answer null for a
 * file that is not there, and `listFiles` skips `.git/`.
 */
export interface SiteFolder {
    readText(path: string): Promise<string | null>
    readBytes(path: string): Promise<Uint8Array | null>
    writeFile(path: string, content: SiteFile): Promise<void>
    remove(path: string): Promise<void>
    /** Every file path under the folder, relative. */
    listFiles(): Promise<string[]>
}

/** Stale files are removed only from the places the publisher owns. */
export function isOwnedPath(path: string): boolean {
    if (path.startsWith('assets/') || path.startsWith('theme/')) return true
    if (path.includes('/')) return false
    return /\.html$/.test(path) || ['search.json', 'search-index.js', 'sitemap.xml', 'feed.xml', 'etherpk-publish.json', '.nojekyll'].includes(path)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

/** Write a site into a folder under the rules above, whatever stands behind the folder. */
export async function writeSite(folder: SiteFolder, bundle: SiteBundle, options: SiteWriteOptions): Promise<SiteWriteResult> {
    const result: SiteWriteResult = { written: 0, unchanged: 0, deleted: [] }
    const total = bundle.size + options.seeded.size + 1
    let done = 0

    for (const [path, content] of bundle) {
        options.onProgress?.(done++, total)
        if (typeof content === 'string') {
            if ((await folder.readText(path)) === content) {
                result.unchanged++
                continue
            }
        } else {
            const existing = await folder.readBytes(path)
            if (existing && sameBytes(existing, content)) {
                result.unchanged++
                continue
            }
        }
        await folder.writeFile(path, content)
        result.written++
    }

    for (const [path, text] of options.seeded) {
        options.onProgress?.(done++, total)
        if ((await folder.readText(path)) !== null) continue
        await folder.writeFile(path, text)
        result.written++
    }

    options.onProgress?.(done++, total)
    const existingAgents = await folder.readText('AGENTS.md')
    const agents = options.agentsMd(existingAgents)
    if (agents !== existingAgents) {
        await folder.writeFile('AGENTS.md', agents)
        result.written++
    }

    // Strays: files in owned places that this publish did not produce.
    for (const path of await folder.listFiles()) {
        if (bundle.has(path) || !isOwnedPath(path)) continue
        await folder.remove(path)
        result.deleted.push(path)
    }
    options.onProgress?.(total, total)
    return result
}

// ── The File System Access API adapter ─────────────────────────────────────────────────────

async function directoryFor(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const parts = path.split('/')
    const name = parts.pop() as string
    let dir = root
    for (const part of parts) {
        try {
            dir = await dir.getDirectoryHandle(part, { create })
        } catch {
            return null
        }
    }
    return { dir, name }
}

/** Every file path under `dir`, relative, `.git/` skipped. */
async function listFiles(dir: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
    const out: string[] = []
    for await (const [name, handle] of dir.entries()) {
        if (name === '.git') continue
        if (handle.kind === 'directory') out.push(...(await listFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)))
        else out.push(`${prefix}${name}`)
    }
    return out
}

/** A picked directory handle as a {@link SiteFolder}. */
export function directoryHandleFolder(root: FileSystemDirectoryHandle): SiteFolder {
    return {
        async readText(path) {
            const at = await directoryFor(root, path, false)
            if (!at) return null
            try {
                const file = await (await at.dir.getFileHandle(at.name)).getFile()
                return await file.text()
            } catch {
                return null
            }
        },
        async readBytes(path) {
            const at = await directoryFor(root, path, false)
            if (!at) return null
            try {
                const file = await (await at.dir.getFileHandle(at.name)).getFile()
                return new Uint8Array(await file.arrayBuffer())
            } catch {
                return null
            }
        },
        async writeFile(path, content) {
            const at = await directoryFor(root, path, true)
            if (!at) throw new Error(`Could not create the folder for ${path}.`)
            const handle = await at.dir.getFileHandle(at.name, { create: true })
            const writable = await handle.createWritable()
            await writable.write(typeof content === 'string' ? content : (content as Uint8Array<ArrayBuffer>))
            await writable.close()
        },
        async remove(path) {
            const at = await directoryFor(root, path, false)
            if (!at) return
            await at.dir.removeEntry(at.name)
        },
        listFiles: () => listFiles(root),
    }
}

export function writeSiteToDirectory(root: FileSystemDirectoryHandle, bundle: SiteBundle, options: SiteWriteOptions): Promise<SiteWriteResult> {
    return writeSite(directoryHandleFolder(root), bundle, options)
}
