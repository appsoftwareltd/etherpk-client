/**
 * The pictures, recordings and other files of a [[Plain Folder]], as something the browser can
 * show: an object URL over the file's bytes, found by its path from the file that references it.
 *
 * A graph resolves an image line by an [[Asset]]'s name. A Plain Folder has no assets, only files
 * in directories the person arranged, so `![bed](images/bed.png)` in `guide/watering.md` means
 * `guide/images/bed.png`. A reference that climbs out of the folder resolves to nothing: the
 * folder is all the person granted.
 */
import { type ResolvedAsset, mimeTypeForExt } from '../storage/fs/asset-store'

import { type FileBytes, type FileStamp, type FolderTreeAdapter, isNotFound } from './folder-tree-adapter'
import { baseName, extensionOf, resolveLink } from './plain-path'

export interface PlainMedia {
    /** The file a reference in the file at `from` names, or null when nothing is there. */
    resolve(from: string, ref: string): Promise<ResolvedAsset | null>
    /** The file at `path` itself. */
    resolvePath(path: string): Promise<ResolvedAsset | null>
    /** Release every object URL handed out. */
    dispose(): void
}

interface Held {
    url: string
    lastModified: number
    size: number
}

export function createPlainMedia(adapter: Pick<FolderTreeAdapter, 'read' | 'stat'>, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL): PlainMedia {
    /** One URL per file, renewed when the file changes on disk. */
    const held = new Map<string, Held>()

    const sameStamps = (kept: Held, now: FileStamp) => kept.lastModified === now.lastModified && kept.size === now.size

    /**
     * Whether the file is as it was when its URL was made, or null when nothing is there. An open
     * tab asks again on every pass over the folder. The file's stamps answer, so its bytes, a long
     * recording's perhaps, are read only when it changed.
     */
    async function unchanged(path: string, kept: Held): Promise<boolean | null> {
        const now = await adapter.stat(path)
        if (now === null) return null
        return now.kind === 'file' && sameStamps(kept, now)
    }

    /** The file's bytes, or null when nothing is there. */
    async function bytesOf(path: string): Promise<FileBytes | null> {
        try {
            return await adapter.read(path)
        } catch (error) {
            if (isNotFound(error)) return null
            throw error
        }
    }

    async function resolvePath(path: string): Promise<ResolvedAsset | null> {
        const answer = (url: string): ResolvedAsset => ({ url, name: baseName(path), type })
        const type = mimeTypeForExt(extensionOf(path))
        const known = held.get(path)
        if (known) {
            const same = await unchanged(path, known)
            if (same === null) return null
            if (same) return answer(known.url)
        }
        const file = await bytesOf(path)
        if (file === null) return null
        // Another request may have read the same bytes while this one waited.
        const kept = held.get(path)
        if (kept && sameStamps(kept, file)) return answer(kept.url)
        if (kept) urls.revokeObjectURL(kept.url)
        const url = urls.createObjectURL(new Blob([file.bytes], { type }))
        held.set(path, { url, lastModified: file.lastModified, size: file.size })
        return answer(url)
    }

    return {
        resolvePath,
        async resolve(from, ref) {
            const target = resolveLink(from, ref)
            return target.kind === 'file' ? resolvePath(target.path) : null
        },
        dispose() {
            for (const { url } of held.values()) urls.revokeObjectURL(url)
            held.clear()
        },
    }
}
