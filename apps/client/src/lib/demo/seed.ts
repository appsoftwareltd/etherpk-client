/**
 * Materialising the [[Demo Graph]] bundle into a graph folder (ADR 0069).
 *
 * The bundle is already in the canonical on-disk layout, so this is a copy with one
 * transformation: the calendar moves to today (date-shift.ts). Nothing is converted, renamed
 * or reported; assets are committed under their final content-hashed names. The import
 * pipeline was the alternative and was rejected for the demo because its conversion,
 * activity toast and Import Report page are all answers to questions a shipped bundle never
 * asks.
 *
 * Pure over the `DirectoryAdapter` seam, so the whole thing is exercised in Node over the
 * in-memory adapter; the browser supplies an OPFS-rooted adapter and `fetch`.
 */
import { SUBDIRS, type DirectoryAdapter, type Subdir } from '$lib/storage/fs/directory-adapter'

import type { DemoBundleManifest } from './bundle-manifest'
import { type DateShift, shiftDatesInText, shiftJournalFileName } from './date-shift'

export interface DemoFile {
    path: string
    bytes: Uint8Array<ArrayBuffer>
}

export interface SeedProgress {
    loadedBytes: number
    totalBytes: number
    /** The bundle path just written. */
    path: string
}

function isSubdir(value: string): value is Subdir {
    return (SUBDIRS as readonly string[]).includes(value)
}

/** Where a bundle file is served from: one static path per segment, each URL-encoded. */
export function demoFileUrl(base: string, path: string): string {
    return `${base}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The bundle's files, fetched one at a time in manifest order. Sequential on purpose: the
 * bundle is small, a burst of parallel requests gains little, and progress reads cleanly.
 */
export async function* fetchDemoBundle(
    manifest: DemoBundleManifest,
    options: { fetch?: typeof fetch; base?: string } = {},
): AsyncGenerator<DemoFile> {
    const fetchImpl = options.fetch ?? fetch
    const base = options.base ?? '/demo-graph'
    for (const file of manifest.files) {
        const response = await fetchImpl(demoFileUrl(base, file.path))
        if (!response.ok) throw new Error(`The demo bundle file ${file.path} could not be fetched (${response.status})`)
        yield { path: file.path, bytes: new Uint8Array(await response.arrayBuffer()) }
    }
}

/**
 * Write the bundle into `adapter`, shifting demo-time dates to today. Journals and pages are
 * text and get the shift in both name and body; `etherpk/` files are copied as they are; assets
 * are bytes. A path outside the four content folders is skipped rather than written: the
 * manifest builder already refused it at build time, so this is belt and braces.
 */
export async function materializeDemoGraph(
    adapter: DirectoryAdapter,
    files: Iterable<DemoFile> | AsyncIterable<DemoFile>,
    shift: DateShift,
    options: { totalBytes?: number; onProgress?: (progress: SeedProgress) => void } = {},
): Promise<void> {
    await adapter.ensureSkeleton()
    const decoder = new TextDecoder()
    let loadedBytes = 0
    for await (const file of files) {
        const [subdir, name, ...rest] = file.path.split('/')
        if (!subdir || !name || rest.length > 0 || !isSubdir(subdir)) continue
        if (subdir === 'journals' || subdir === 'pages') {
            const text = shiftDatesInText(decoder.decode(file.bytes), shift)
            const fileName = subdir === 'journals' ? shiftJournalFileName(name, shift) : name
            await adapter.write(subdir, fileName, text)
        } else if (subdir === 'etherpk') {
            await adapter.write(subdir, name, decoder.decode(file.bytes))
        } else {
            await adapter.writeBinary(subdir, name, file.bytes)
        }
        loadedBytes += file.bytes.byteLength
        options.onProgress?.({ loadedBytes, totalBytes: options.totalBytes ?? loadedBytes, path: file.path })
    }
}
