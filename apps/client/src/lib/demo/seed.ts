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

/**
 * The reserved characters `decodeURI` leaves escaped. A static server that decodes request paths
 * with it, as Vite's does, would look for a file literally named `%2C`, so these go unescaped:
 * each is valid as it is inside a path segment. `#` and `?` stay escaped and cannot be served at
 * all, which is why the manifest builder refuses a name with `#` (`?` is illegal in a file name).
 */
const LITERAL_IN_PATH = /%(2C|3B|40|26|3D|2B|24)/gi

/** Where a bundle file is served from: one static path per segment, each URL-encoded. */
export function demoFileUrl(base: string, path: string): string {
    const segment = (name: string) => encodeURIComponent(name).replace(LITERAL_IN_PATH, (escape) => decodeURIComponent(escape))
    return `${base}/${path.split('/').map(segment).join('/')}`
}

/** How many bundle files are requested at once by default. */
const DEFAULT_FETCH_CONCURRENCY = 6

/**
 * The bundle's files, yielded in manifest order. A few requests are kept in flight ahead of the
 * file being yielded: the bundle is a few hundred small pages, and one request at a time would
 * cost a network round trip per page. Order is kept so progress reads cleanly and the first
 * missing file is the one reported.
 */
export async function* fetchDemoBundle(
    manifest: DemoBundleManifest,
    options: { fetch?: typeof fetch; base?: string; concurrency?: number } = {},
): AsyncGenerator<DemoFile> {
    const fetchImpl = options.fetch ?? fetch
    const base = options.base ?? '/demo-graph'
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_FETCH_CONCURRENCY)

    const fetchFile = async (path: string): Promise<DemoFile> => {
        const response = await fetchImpl(demoFileUrl(base, path))
        if (!response.ok) throw new Error(`The demo bundle file ${path} could not be fetched (${response.status})`)
        return { path, bytes: new Uint8Array(await response.arrayBuffer()) }
    }

    const ahead: Promise<DemoFile>[] = []
    let next = 0
    const startMore = () => {
        while (ahead.length < concurrency && next < manifest.files.length) {
            const request = fetchFile(manifest.files[next++].path)
            // A request that fails while an earlier one is still awaited would otherwise be an
            // unhandled rejection. It is still awaited, and thrown, when its turn comes.
            request.catch(() => {})
            ahead.push(request)
        }
    }

    startMore()
    for (let request = ahead.shift(); request; request = ahead.shift()) {
        const file = await request
        startMore()
        yield file
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
