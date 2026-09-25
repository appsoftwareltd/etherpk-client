/**
 * A {@link DirectoryAdapter} that streams into a zip: the target of an [[Export]] (ADR 0092).
 *
 * The mirror pass writes a graph the way it writes a folder, so the export runs that pass over
 * this adapter instead of writing a folder-shaped copy of its own. Two lifetimes live here.
 * Binary writes - the attachments, the bulk of any graph - go straight into the archive and are
 * then forgotten, so the working set is whatever the pass holds in hand, never the graph. Text
 * files are kept until `close()`, because the pass lists and reads what it has written to plan
 * names, and a document rewritten within a pass must land once, as its last version.
 *
 * An archive cannot take a file back. On the empty target an export starts from, the pass never
 * removes an asset or reads one back (its copy path fires only for a name already present), so
 * both are refused here rather than faked: a wrong archive is worse than a failed export.
 */

import type { BinaryContent, DirectoryAdapter, DirEntry, FileContent, Subdir } from '$lib/storage/fs/directory-adapter'
import type { ZipWriter } from '$lib/zip/zip-writer'

export interface ZipDirectoryAdapterOptions {
    /** The single top-level folder every entry sits under: what unzipping produces. */
    root: string
    now?: () => number
}

export interface ZipDirectoryAdapter extends DirectoryAdapter {
    /** Write the held text files and the archive's central directory. */
    close(): Promise<void>
}

interface HeldText {
    text: string
    size: number
    lastModified: number
}

interface Streamed {
    size: number
    lastModified: number
}

const encoder = new TextEncoder()

export function createZipDirectoryAdapter(writer: ZipWriter, options: ZipDirectoryAdapterOptions): ZipDirectoryAdapter {
    const now = options.now ?? (() => Date.now())
    const root = options.root.replace(/\/+$/, '')
    /** Keys are `subdir/name`, or `./name` for a file beside the four folders. */
    const held = new Map<string, HeldText>()
    const streamed = new Map<string, Streamed>()

    const key = (subdir: Subdir, name: string) => `${subdir}/${name}`
    const rootKey = (name: string) => `./${name}`
    const zipPath = (k: string) => `${root}/${k.startsWith('./') ? k.slice(2) : k}`
    const alreadyStreamed = (k: string) => new Error(`"${k}" is already in the archive and cannot be changed`)

    function content(k: string): FileContent {
        const entry = held.get(k)
        if (entry) return { text: entry.text, lastModified: entry.lastModified, size: entry.size }
        if (streamed.has(k)) throw new Error(`"${k}" cannot be read back from an export in progress`)
        throw new Error(`No such file: ${k}`)
    }

    function hold(k: string, text: string): FileContent {
        const entry: HeldText = { text, size: encoder.encode(text).length, lastModified: now() }
        held.set(k, entry)
        return { text, lastModified: entry.lastModified, size: entry.size }
    }

    return {
        async list(subdir): Promise<DirEntry[]> {
            const prefix = `${subdir}/`
            const out: DirEntry[] = []
            for (const [k, entry] of streamed) {
                if (k.startsWith(prefix)) out.push({ name: k.slice(prefix.length), lastModified: entry.lastModified, size: entry.size })
            }
            for (const [k, entry] of held) {
                if (k.startsWith(prefix)) out.push({ name: k.slice(prefix.length), lastModified: entry.lastModified, size: entry.size })
            }
            return out
        },

        async read(subdir, name) {
            return content(key(subdir, name))
        },

        async write(subdir, name, text) {
            const k = key(subdir, name)
            if (streamed.has(k)) throw alreadyStreamed(k)
            return hold(k, text)
        },

        async readBinary(subdir, name): Promise<BinaryContent> {
            throw new Error(`"${key(subdir, name)}" cannot be read back from an export in progress`)
        },

        async writeBinary(subdir, name, bytes) {
            const k = key(subdir, name)
            if (streamed.has(k) || held.has(k)) throw alreadyStreamed(k)
            const lastModified = now()
            await writer.add(zipPath(k), bytes, { compress: false, mtime: lastModified })
            streamed.set(k, { size: bytes.length, lastModified })
            return { bytes, lastModified }
        },

        async exists(subdir, name) {
            const k = key(subdir, name)
            return held.has(k) || streamed.has(k)
        },

        async remove(subdir, name) {
            const k = key(subdir, name)
            if (streamed.has(k)) throw alreadyStreamed(k)
            held.delete(k)
        },

        async ensureSkeleton() {
            // Folders are implicit in an archive's entry names.
        },

        async readRootFile(name) {
            const entry = held.get(rootKey(name))
            return entry ? { text: entry.text, lastModified: entry.lastModified, size: entry.size } : null
        },

        async writeRootFile(name, text) {
            return hold(rootKey(name), text)
        },

        async close() {
            for (const [k, entry] of held) {
                await writer.add(zipPath(k), encoder.encode(entry.text), { compress: true, mtime: entry.lastModified })
            }
            held.clear()
            await writer.close()
        },
    }
}
