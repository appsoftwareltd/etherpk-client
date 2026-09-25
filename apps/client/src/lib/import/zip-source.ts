/**
 * A zip as an [[Import]] source (ADR 0092): the other half of an [[Export]]'s round trip, and
 * the only way in on a phone, which has no folder picker.
 *
 * The archive is read through its central directory, so listing costs one read of the file's
 * tail however large it is. Each entry becomes a {@link SourceFile} the converters read exactly
 * as they read a picked folder's. A stored entry - every attachment an export writes - is a
 * `slice()` of the picked file, so nothing is loaded until a converter reads it; a deflated
 * entry is inflated into a Blob here, one at a time. A single top-level folder, which is what
 * an export and most zip tools produce, is stripped the way the folder picker's own name is.
 */

import { blobSource, readZipDirectory, readZipEntry, zipEntryDataRange, type RandomAccessSource, type ZipEntry } from '$lib/zip/zip-reader'

import { describeSource, isJunkPath, type SourceSummary } from './source'
import type { SourceFile } from './types'

const STORED = 0
/** Resource forks and Finder metadata a macOS zip carries beside the real tree. */
const MACOS_JUNK_ROOT = '__MACOSX'

/** The browser sets a picked file's type from its name; a slice of a zip gets the same courtesy. */
const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
}

function mimeTypeOf(path: string): string {
    const dot = path.lastIndexOf('.')
    return dot === -1 ? '' : (MIME_TYPES[path.slice(dot + 1).toLowerCase()] ?? '')
}

/**
 * An entry's name as a `/`-separated path relative to the archive root, or null for one that
 * cannot be placed: a parent segment, an empty segment, or Finder's shadow tree.
 */
export function normaliseZipPath(name: string): string | null {
    let path = name.replace(/\\/g, '/')
    while (path.startsWith('./') || path.startsWith('/')) path = path.replace(/^(\.\/|\/)/, '')
    if (!path) return null
    const segments = path.split('/')
    if (segments.some((segment) => segment === '' || segment === '..')) return null
    if (segments[0] === MACOS_JUNK_ROOT) return null
    return path
}

/** The one folder every content path sits under, or null when there is no such folder. */
export function commonZipRoot(paths: readonly string[]): string | null {
    let root: string | null = null
    for (const path of paths) {
        const slash = path.indexOf('/')
        if (slash === -1) return null
        const first = path.slice(0, slash)
        if (root === null) root = first
        else if (root !== first) return null
    }
    return root
}

async function dataOf(file: Blob, source: RandomAccessSource, entry: ZipEntry, path: string): Promise<Blob> {
    const type = mimeTypeOf(path)
    if (entry.method === STORED) {
        const { start, end } = await zipEntryDataRange(source, entry)
        return file.slice(start, end, type)
    }
    return new Blob([await readZipEntry(source, entry)], { type })
}

/** Build the converter input from a picked zip; null when it holds no files. */
export async function prepareZipSource(file: File): Promise<SourceSummary | null> {
    const source = blobSource(file)
    const named: Array<{ entry: ZipEntry; path: string }> = []
    for (const entry of await readZipDirectory(source)) {
        if (entry.directory) continue
        const path = normaliseZipPath(entry.path)
        if (path !== null) named.push({ entry, path })
    }
    // Junk is left out of the root question: a `.DS_Store` beside the folder must not stop the
    // folder being recognised as the root, and it is filtered later like a picked folder's.
    const root = commonZipRoot(named.map((n) => n.path).filter((path) => !isJunkPath(path)))
    const files: SourceFile[] = []
    for (const { entry, path } of named) {
        const relative = root !== null && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
        if (!relative) continue
        files.push({ path: relative, data: await dataOf(file, source, entry, relative) })
    }
    if (files.length === 0) return null
    return describeSource(files, root ?? file.name.replace(/\.zip$/i, ''))
}
