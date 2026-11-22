/**
 * Where a file pasted or dropped into a document of a [[Plain Folder]] is kept, and the link that
 * is written for it.
 *
 * A graph keeps every such file in one `assets` directory under a name that carries its content
 * hash. A Plain Folder is browsed in other tools, by people who did not paste the file, so the
 * file keeps its own name and sits near the document that shows it: by default in an `assets`
 * directory beside the document, created the first time it is needed. A screenshot arrives with no
 * name of its own and is named by the time it was taken (clipboard-assets.ts) before it reaches
 * here. The link written is the relative link from the document, which every markdown tool reads.
 *
 * `createPlainAssetStore` is the editor's `AssetStore` for one document, so paste, drop and the
 * upload dialog work as they do in a graph.
 */
import { type AssetStore, type SavedAsset, isImageExt, splitNameExt } from '../storage/fs/asset-store'

import type { FolderTreeAdapter } from './folder-tree-adapter'
import type { PlainMedia } from './plain-media'
import { baseName, dirOf, extensionOf, joinPath, relativeLink, resolveLink } from './plain-path'

/** Where a pasted file goes, relative to the document that shows it. */
export type AssetPlacement =
    /** An `assets` directory beside the document. The default. */
    | 'assets'
    /** The document's own directory. */
    | 'beside'
    /** A directory named after the document: `watering.assets` for `watering.md`. */
    | 'named'

export const DEFAULT_ASSET_PLACEMENT: AssetPlacement = 'assets'

/** The directory a file pasted into the document at `document` is written to. */
export function assetDirectoryFor(document: string, placement: AssetPlacement): string {
    const dir = dirOf(document)
    if (placement === 'beside') return dir
    if (placement === 'named') return joinPath(dir, `${splitNameExt(baseName(document)).stem}.assets`)
    return joinPath(dir, 'assets')
}

/** A file name safe on every file system here: characters none of them take become hyphens. */
export function safeFileName(name: string): string {
    const cleaned = [...name.normalize('NFC')]
        .map((char) => (char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? '-' : char))
        .join('')
        .trim()
        .replace(/[. ]+$/, '')
    return cleaned === '' ? 'file' : cleaned
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])

type Tree = Pick<FolderTreeAdapter, 'stat' | 'read' | 'write' | 'createDirectory'>

/**
 * Write a pasted or dropped file near the document that shows it. A file already there with the
 * same bytes is used as it is, so pasting one picture twice keeps one file. A different file of
 * the same name is kept beside it as `name (2).png`. Resolves with where it is and what was done.
 */
export async function saveBeside(
    tree: Tree,
    document: string,
    file: { name: string; bytes: Uint8Array<ArrayBuffer> },
    placement: AssetPlacement,
): Promise<{ path: string; reused: boolean }> {
    const dir = assetDirectoryFor(document, placement)
    const { stem, ext } = splitNameExt(safeFileName(file.name))
    for (let n = 1; ; n++) {
        const name = `${stem}${n === 1 ? '' : ` (${n})`}${ext ? `.${ext}` : ''}`
        const path = joinPath(dir, name)
        const there = await tree.stat(path)
        if (there === null) {
            await tree.createDirectory(dir)
            await tree.write(path, file.bytes)
            return { path, reused: false }
        }
        if (there.kind === 'file' && there.size === file.bytes.length && sameBytes((await tree.read(path)).bytes, file.bytes)) return { path, reused: true }
    }
}

/** The editor's asset store for the document at `document`: files go near it, and links are relative to it. */
export function createPlainAssetStore(tree: Tree, media: PlainMedia, document: () => string, placement: () => AssetPlacement): AssetStore {
    const bytesOf = async (ref: string) => {
        const target = resolveLink(document(), ref)
        if (target.kind !== 'file') return null
        try {
            return { path: target.path, file: await tree.read(target.path) }
        } catch {
            return null
        }
    }
    return {
        async save(file, onBytes) {
            const saved = await saveBeside(tree, document(), file, placement())
            onBytes?.(file.bytes.length)
            const name = baseName(saved.path)
            return {
                ref: relativeLink(document(), saved.path),
                name,
                stem: splitNameExt(name).stem,
                isImage: isImageExt(extensionOf(name)),
                ...(saved.reused ? { reused: true } : {}),
            } satisfies SavedAsset
        },
        resolve: (ref) => media.resolve(document(), ref),
        async readBytes(ref) {
            const found = await bytesOf(ref)
            if (!found) return null
            const resolved = await media.resolvePath(found.path)
            return resolved ? { bytes: found.file.bytes, name: resolved.name, type: resolved.type } : null
        },
        dispose() {},
    }
}
