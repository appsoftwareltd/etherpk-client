/**
 * Asset planning: every non-markdown content file becomes an [[Asset]] under `assets/`,
 * named by the existing convention (`kebab-stem.<contenthash>.ext` - same grammar as
 * the Asset store, so identical bytes dedupe to one file). Unreferenced files import
 * anyway (data ownership) and are counted in the report. EtherPK sources keep their
 * names verbatim - they already conform.
 */

import { publishSlug } from '$lib/document/wikilink'
import { assetFileName, isImageExt, splitNameExt } from '$lib/storage/fs/asset-store'

import { baseName } from './source'
import { breathe, type ConvertedAsset, type ImportControl, type SourceFile } from './types'

export interface PlannedAsset {
    /** Source path (root-relative). */
    path: string
    /** The doc-relative reference documents use, `../assets/<fileName>`. */
    ref: string
    /** Markdown link/alt label (the kebab stem). */
    stem: string
    isImage: boolean
    asset: ConvertedAsset
}

export interface AssetPlan {
    byPath: Map<string, PlannedAsset>
    /** Lower-cased base name → planned assets (Obsidian resolves embeds by base name). */
    byBaseName: Map<string, PlannedAsset[]>
    assets: ConvertedAsset[]
    markReferenced(planned: PlannedAsset): void
}

/** First 8 hex chars of the SHA-256 - the same content hash the Asset store uses. */
async function contentHash(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 8)
}

export async function planAssets(
    files: SourceFile[],
    options: { verbatim?: boolean; control?: ImportControl } = {},
): Promise<AssetPlan> {
    const byPath = new Map<string, PlannedAsset>()
    const byBaseName = new Map<string, PlannedAsset[]>()
    // Dedupe key: CONTENT and extension, matching the Asset store - the kebab stem is display,
    // not identity. Keying by the whole target name (which is what this did) let one vault import
    // the same bytes once per name they appeared under, which on a real vault is most of them.
    // Verbatim sources are keyed by name instead: those names are already final and were
    // content-addressed by whoever wrote them, so two distinct names are two assets.
    const byContent = new Map<string, ConvertedAsset>()
    const assets: ConvertedAsset[] = []

    // Measured in BYTES, like every other asset phase. This pass reads and content-hashes
    // every asset in the source: on a real graph that is gigabytes, and a file counter
    // stalls dead on each large one (measured: 4 of 6168 files carried 14% of the bytes).
    const totalBytes = files.reduce((sum, f) => sum + f.data.size, 0)
    let done = 0
    for (const file of files) {
        // Hashing is CPU-bound over the whole vault; yield so the toast keeps moving.
        await breathe(options.control)
        options.control?.onProgress?.({ label: 'Preparing assets', done, total: totalBytes, unit: 'bytes' })
        done += file.data.size
        const name = baseName(file.path)
        const { stem, ext } = splitNameExt(name)
        const key = options.verbatim ? name : `${await contentHash(await file.data.arrayBuffer())}.${ext}`

        let asset = byContent.get(key)
        if (!asset) {
            // `key` is `<hash>.<ext>` here, which is exactly what assetFileName builds the name
            // around; verbatim sources keep the name they arrived with.
            const fileName = options.verbatim ? name : assetFileName(name, key.slice(0, 8))
            asset = { fileName, data: file.data, unreferenced: true }
            byContent.set(key, asset)
            assets.push(asset)
        }
        // One PlannedAsset per SOURCE file, sharing the one stored asset: the documents that
        // referenced this file keep its own name as their markdown label even when the bytes
        // are already stored under another file's name.
        const planned: PlannedAsset = {
            path: file.path,
            ref: `../assets/${asset.fileName}`,
            stem: publishSlug(stem) || 'asset',
            isImage: isImageExt(ext),
            asset,
        }
        byPath.set(file.path, planned)
        const baseKey = name.toLowerCase()
        byBaseName.set(baseKey, [...(byBaseName.get(baseKey) ?? []), planned])
    }
    // Land the phase on 100% rather than one file short of it.
    if (files.length > 0) {
        options.control?.onProgress?.({ label: 'Preparing assets', done, total: totalBytes, unit: 'bytes' })
    }

    return {
        byPath,
        byBaseName,
        assets,
        markReferenced(planned) {
            planned.asset.unreferenced = false
        },
    }
}

/** Decode a percent-encoded path segment safely (a stray `%` degrades to the raw text). */
export function tryDecode(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

/** Normalise a doc-relative reference (`../assets/a.png`, `./x/y.png`) to a root-relative path. */
export function normaliseRef(ref: string, fromDir: string): string {
    const clean = tryDecode(ref.split(/[?#]/)[0])
    if (clean.startsWith('../') || clean.startsWith('./')) {
        const segments = (fromDir === '' ? [] : fromDir.split('/')).concat(clean.split('/'))
        const out: string[] = []
        for (const segment of segments) {
            if (segment === '.' || segment === '') continue
            if (segment === '..') out.pop()
            else out.push(segment)
        }
        return out.join('/')
    }
    return clean
}
