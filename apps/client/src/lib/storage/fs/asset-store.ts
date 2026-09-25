/**
 * The **Asset store** over a {@link DirectoryAdapter}: uploads land as binary files
 * under `assets/`, named `kebab-stem.<contenthash>.ext` (DESIGN.md → On-disk layout).
 * Identical bytes de-duplicate to one file **by content and extension alone** - the stem is
 * display, not identity - so the same file added again under a different name references the
 * one already stored rather than writing a second copy. Built on the same File-System seam as
 * {@link createFilesystemDocumentStore}, so the pure naming/dedup logic is Node-testable
 * over the in-memory adapter before any browser code runs.
 *
 * Assets are referenced from documents by a relative path — `../assets/<name>` — which
 * resolves from any journal entry or page (both sit one level under the graph root,
 * the Logseq convention). `resolve` reads those bytes back and hands out an object URL plus
 * the name and MIME type a download or a viewer needs; the URLs are cached per asset and
 * revoked on {@link AssetStore.dispose}.
 *
 * Remote (S3) upload and per-graph access control are deferred (DESIGN.md → Server
 * Backend); this is the Filesystem Backend path only.
 */

import { publishSlug } from '$lib/document/wikilink'

import { assetHashFromName } from './asset-names'
import type { DirectoryAdapter } from './directory-adapter'

// Re-exported so callers keep one import for the store and its naming rules.
export { assetHashFromName }

/** Extensions rendered inline as images (everything else renders as a download link). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])

/** A doc-relative asset reference: optional `../` hops, then `assets/<name>`. */
const ASSET_REF = /^(?:\.\.\/)*assets\/(.+)$/

/** The outcome of a {@link AssetStore.save}: the markdown reference plus the bits the inserter needs. */
export interface SavedAsset {
    /** The doc-relative reference to embed, e.g. `../assets/diagram.a1b2c3d4.png`. */
    ref: string
    /** The on-disk file name under `assets/`. */
    name: string
    /** The kebab-cased original stem — the markdown link/alt label. */
    stem: string
    /** True when the asset renders inline as an image. */
    isImage: boolean
    /**
     * True when the graph already held these bytes and the reference points at the existing
     * asset (nothing was stored). Both backends report it, so the Activity toast can say
     * "already in this graph, reused": a local graph reads the hash back out of the names in
     * `assets/`, a synced graph asks the server with a blinded token (ADR 0053).
     */
    reused?: boolean
}

/**
 * Byte-level progress within one {@link AssetStore.save}. Called with the number of SOURCE
 * bytes newly durable (not ciphertext bytes, which are slightly larger and would make the
 * totals not add up). Exists so an [[Activity Toast]] can measure an asset phase in bytes:
 * a graph whose 240 assets include three 400 MB files looks stalled counted by file.
 */
export type AssetSaveProgressFn = (bytesDone: number) => void

/**
 * An [[Asset]]'s bytes plus the two things a caller needs to *present* them: what to call the
 * file, and what it is. Both backends hold this already — the Server one decrypts the true
 * original name and MIME type out of the asset metadata, the Filesystem one derives them from
 * the on-disk name — and before this both threw it away and handed back a bare URL, which is
 * why a download was named with a content hash in it and a viewer had no type to work from.
 */
export interface ResolvedAsset {
    /** Object URL for rendering, download, or a viewer. Cached per asset, revoked on dispose. */
    url: string
    /** What to call the file: the true original name where it is known, else the on-disk name
     *  with its content hash taken out. Never carries the hash. */
    name: string
    /** MIME type, or `''` when it cannot be named — never a guess. */
    type: string
}

export interface AssetStore {
    /** Hash the bytes, derive the name, write-unless-present, and return the reference to embed. */
    save(
        file: { name: string; bytes: Uint8Array<ArrayBuffer>; type: string },
        onBytes?: AssetSaveProgressFn,
    ): Promise<SavedAsset>
    /** Resolve a doc-relative asset reference to its bytes, name and type; `null` if absent or not an asset ref. */
    resolve(ref: string): Promise<ResolvedAsset | null>
    /**
     * The same bytes as {@link resolve}, handed over directly rather than behind an object URL.
     * For a caller that writes them somewhere - the [[Local Mirror]] - where a URL would be an
     * extra copy of every asset, held until the store is disposed.
     */
    readBytes(ref: string): Promise<AssetBytes | null>
    /** Revoke every object URL handed out by {@link resolve}. Call on graph close. */
    dispose(): void
}

/** An [[Asset]]'s plain bytes with the two things a caller needs to name them. */
export interface AssetBytes {
    /** ArrayBuffer-backed, so it passes straight to the File System Access API. */
    bytes: Uint8Array<ArrayBuffer>
    name: string
    type: string
}

/** Split a file name into its stem and lower-cased extension (`''` ext when there is none). */
export function splitNameExt(fileName: string): { stem: string; ext: string } {
    const dot = fileName.lastIndexOf('.')
    if (dot <= 0) return { stem: fileName, ext: '' }
    return { stem: fileName.slice(0, dot), ext: fileName.slice(dot + 1).toLowerCase() }
}

/** True when `ext` (with or without a leading dot) names an inline-rendered image format. */
export function isImageExt(ext: string): boolean {
    return IMAGE_EXTS.has(ext.replace(/^\./, '').toLowerCase())
}

/** The on-disk asset name: `kebab-stem.<hash>.ext` (stem falls back to `asset` when slugging empties it). */
export function assetFileName(originalName: string, hash: string): string {
    const { stem, ext } = splitNameExt(originalName)
    const slug = publishSlug(stem) || 'asset'
    return ext ? `${slug}.${hash}.${ext}` : `${slug}.${hash}`
}


/** The de-duplication key: content plus extension. The stem is display, not identity. */
function contentKey(hash: string, ext: string): string {
    return `${hash}.${ext}`
}

/**
 * An on-disk asset name with its content hash taken back out — `q3-report.a1b2c3d4.pdf` reads as
 * `q3-report.pdf`. What a download is called and what titles an asset tab, so neither shows a
 * user a hash they never typed. A name this store did not write is returned unchanged.
 */
export function displayAssetName(fileName: string): string {
    const parsed = assetHashFromName(fileName)
    if (!parsed) return fileName
    const stem = fileName.slice(0, fileName.length - `.${parsed.hash}`.length - (parsed.ext ? parsed.ext.length + 1 : 0))
    return parsed.ext ? `${stem}.${parsed.ext}` : stem
}

/**
 * MIME types for the formats the app itself renders, plus the handful a browser needs told about
 * to do anything sensible with a download. Deliberately small and deliberately **empty for
 * anything else**: a wrong type is worse than none, because a wrong one is acted on. The
 * Filesystem Backend has nowhere else to learn a type from — unlike the Server Backend, which
 * carries the uploader's own MIME type inside the encrypted asset metadata.
 */
const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    md: 'text/markdown',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    zip: 'application/zip',
}

/** The MIME type for a file extension (with or without a leading dot), or `''` when unknown. */
export function mimeTypeForExt(ext: string): string {
    return MIME_TYPES[ext.replace(/^\./, '').toLowerCase()] ?? ''
}

/** The on-disk name referenced by a doc-relative asset ref, or `null` if `ref` is not an asset reference. */
export function assetNameFromRef(ref: string): string | null {
    const clean = ref.split(/[?#]/)[0]
    const match = ASSET_REF.exec(clean)
    return match ? decodeURIComponent(match[1]) : null
}

/**
 * What to call a reference in text a person reads or hears: the file's own name, hash-free. Every
 * surface that labels an [[Asset Reference]] asks this — the action buttons' accessible names in
 * the editor and in the Backlinks [[View]], and a reference written with no label at all — so a
 * screen reader is never read a content hash. A reference naming no asset is returned unchanged.
 */
export function displayNameForRef(ref: string): string {
    const name = assetNameFromRef(ref)
    return name ? displayAssetName(name) : ref
}

/**
 * The markdown to embed a saved asset: an inline image, or a plain link that downloads on click.
 * For an image, an optional `displaySize` (e.g. `300` or `300x200`) is added as a `|` display-size
 * hint; the caller is responsible for passing a valid spec (see `normalizeDisplaySize`).
 */
export function buildAssetMarkdown(
    asset: { ref: string; stem: string; isImage: boolean },
    displaySize?: string,
): string {
    if (!asset.isImage) return `[${asset.stem}](${asset.ref})`
    const alt = displaySize ? `${asset.stem}|${displaySize}` : asset.stem
    return `![${alt}](${asset.ref})`
}

/** First 8 hex chars of the SHA-256 of the bytes — the content hash in the asset name. */
async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8)
}

export function createAssetStore(adapter: DirectoryAdapter): AssetStore {
    // One object URL per asset name; reused across re-renders and revoked on dispose.
    const urlCache = new Map<string, string>()

    /**
     * Content key → the on-disk name already holding those bytes. Built from `assets/` on the
     * first save (so a store that only ever resolves never pays for the listing) and maintained
     * on every write after that.
     *
     * This is what keeps the [[Asset]] guarantee honest on this backend: identity is content,
     * not the name it was added under. Keying the write on the whole file name instead — which
     * is what this did before — stored the same bytes twice whenever the stem differed.
     */
    let contentIndex: Map<string, string> | undefined

    async function assetsByContent(): Promise<Map<string, string>> {
        if (contentIndex) return contentIndex
        const index = new Map<string, string>()
        for (const { name } of await adapter.list('assets')) {
            const parsed = assetHashFromName(name)
            // First name wins, so the file an asset is stored under is stable across sessions.
            if (parsed && !index.has(contentKey(parsed.hash, parsed.ext))) {
                index.set(contentKey(parsed.hash, parsed.ext), name)
            }
        }
        contentIndex = index
        return index
    }

    return {
        async save({ name, bytes }, onBytes) {
            const hash = await contentHash(bytes)
            const { stem, ext } = splitNameExt(name)
            const index = await assetsByContent()
            const key = contentKey(hash, ext)
            // Already here under some name: reference that file. The new name still supplies the
            // markdown label, so the reference reads as the user's own while the bytes are shared.
            const existing = index.get(key)
            const fileName = existing ?? assetFileName(name, hash)
            if (!existing) {
                await adapter.writeBinary('assets', fileName, bytes)
                index.set(key, fileName)
            }
            // A local write is one indivisible step, so the whole file lands at once. A
            // deduped write reports too - the caller is measuring work retired, not bytes
            // pushed through a socket.
            onBytes?.(bytes.length)
            return {
                ref: `../assets/${fileName}`,
                name: fileName,
                stem: publishSlug(stem) || 'asset',
                isImage: isImageExt(ext),
                ...(existing ? { reused: true } : {}),
            }
        },

        async readBytes(ref) {
            const assetName = assetNameFromRef(ref)
            if (!assetName) return null
            const { ext } = splitNameExt(assetName)
            try {
                const { bytes } = await adapter.readBinary('assets', assetName)
                return { bytes, name: displayAssetName(assetName), type: mimeTypeForExt(ext) }
            } catch {
                return null // absent on disk — the caller shows a broken-asset affordance
            }
        },

        async resolve(ref) {
            const assetName = assetNameFromRef(ref)
            if (!assetName) return null
            const { ext } = splitNameExt(assetName)
            const meta = { name: displayAssetName(assetName), type: mimeTypeForExt(ext) }
            const cached = urlCache.get(assetName)
            if (cached) return { url: cached, ...meta }
            let content
            try {
                content = await adapter.readBinary('assets', assetName)
            } catch {
                return null // absent on disk — the caller shows a broken-asset affordance
            }
            // The type matters: a typeless blob is content-sniffed by whatever it is handed to,
            // and a download of one arrives with no type at all.
            const url = URL.createObjectURL(new Blob([content.bytes], meta.type ? { type: meta.type } : {}))
            urlCache.set(assetName, url)
            return { url, ...meta }
        },

        dispose() {
            for (const url of urlCache.values()) URL.revokeObjectURL(url)
            urlCache.clear()
        },
    }
}
