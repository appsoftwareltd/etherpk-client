/**
 * An in-memory {@link DirectoryAdapter}. The Vitest unit tests and the dev
 * harness use it as a stand-in for a real directory, so the whole
 * FilesystemDocumentStore can be proven in Node before any browser File System
 * Access / OPFS code exists.
 *
 * mtimes come from an injected clock so tests are deterministic (production wires
 * the real adapters, where mtimes come from the platform). Reads/lists return
 * copies, so a caller cannot mutate the backing store by reference.
 */

import {
    type DirectoryAdapter,
    type DirEntry,
    type Subdir,
    SUBDIRS,
} from './directory-adapter'

export interface MemoryDirectoryAdapterOptions {
    /** Monotonic clock (epoch-ms) stamped onto each write. */
    now: () => number
    /** Optional initial files, keyed by subdir then file name. */
    seed?: Partial<Record<Subdir, Record<string, string>>>
}

/** A stored file: text or raw bytes (text/binary writes are mutually exclusive), with its mtime and size. */
interface MemEntry {
    text?: string
    bytes?: Uint8Array<ArrayBuffer>
    lastModified: number
    /** Bytes on "disk", as a real listing reports it: UTF-8 length for text, not code units. */
    size: number
}

function key(subdir: Subdir, name: string): string {
    return `${subdir}/${name}`
}

/** Root files share the flat namespace under a prefix no {@link Subdir} can produce. */
function rootKey(name: string): string {
    return `./${name}`
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length
}

export function createMemoryDirectoryAdapter(
    options: MemoryDirectoryAdapterOptions,
): DirectoryAdapter {
    const { now, seed } = options
    const files = new Map<string, MemEntry>()

    // Seed before the test's first explicit write so seeded mtimes are earliest.
    if (seed) {
        for (const subdir of SUBDIRS) {
            const entries = seed[subdir]
            if (!entries) continue
            for (const [name, text] of Object.entries(entries)) {
                files.set(key(subdir, name), { text, size: utf8Length(text), lastModified: now() })
            }
        }
    }

    return {
        async list(subdir) {
            const prefix = `${subdir}/`
            const out: DirEntry[] = []
            for (const [k, content] of files) {
                if (k.startsWith(prefix)) {
                    out.push({ name: k.slice(prefix.length), lastModified: content.lastModified, size: content.size })
                }
            }
            return out
        },

        async read(subdir, name) {
            const content = files.get(key(subdir, name))
            if (!content) throw new Error(`No such file: ${subdir}/${name}`)
            // Binary-only files decode on read so a text read never returns undefined.
            const text = content.text ?? new TextDecoder().decode(content.bytes ?? new Uint8Array())
            return { text, lastModified: content.lastModified, size: content.size }
        },

        async write(subdir, name, text) {
            const content: MemEntry = { text, size: utf8Length(text), lastModified: now() }
            files.set(key(subdir, name), content)
            return { text, lastModified: content.lastModified, size: content.size }
        },

        async readBinary(subdir, name) {
            const content = files.get(key(subdir, name))
            if (!content) throw new Error(`No such file: ${subdir}/${name}`)
            // Text-only files encode on read, mirroring the text path's decode. `new Uint8Array`
            // copies into an ArrayBuffer-backed view (callers must not mutate the store).
            const source = content.bytes ?? new TextEncoder().encode(content.text ?? '')
            return { bytes: new Uint8Array(source), lastModified: content.lastModified }
        },

        async writeBinary(subdir, name, bytes) {
            const content: MemEntry = { bytes: bytes.slice(), size: bytes.length, lastModified: now() }
            files.set(key(subdir, name), content)
            return { bytes, lastModified: content.lastModified }
        },

        async exists(subdir, name) {
            return files.has(key(subdir, name))
        },

        async remove(subdir, name) {
            files.delete(key(subdir, name))
        },

        async ensureSkeleton() {
            // Subdirs are implicit in the flat key namespace — nothing to create.
        },

        async readRootFile(name) {
            const content = files.get(rootKey(name))
            if (!content) return null
            const text = content.text ?? new TextDecoder().decode(content.bytes ?? new Uint8Array())
            return { text, lastModified: content.lastModified, size: content.size }
        },

        async writeRootFile(name, text) {
            const content: MemEntry = { text, size: utf8Length(text), lastModified: now() }
            files.set(rootKey(name), content)
            return { text, lastModified: content.lastModified, size: content.size }
        },
    }
}
