/**
 * Building a {@link PublishSource} from a graph: materialised text for every document, the cipher
 * fence still in it, and a way to read an asset. The same seam the [[Local Mirror]] reads
 * through on a [[Server Backend]] (`readTexts`: cache-seeded batches, never `open()`), and the
 * folder's files on a [[Filesystem Backend]]. Nothing here holds a [[Protection Key]].
 */

import type { AssetStore } from '$lib/storage/fs/asset-store'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { aliasesOf, conceptOf, journalConceptOf } from '$lib/storage/fs/identity'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'

import type { PublishDocument, PublishSource } from './types'

/** What the two backends have in common: an identity list and a batched text read. */
export interface PublishReader {
    listDocuments(): { docId: string; kind: 'page' | 'journal'; concept: string; aliases?: readonly string[] }[]
    readTexts(
        docIds: readonly string[],
        onProgress?: (done: number, total: number) => void,
    ): Promise<Map<string, { text: string; settled: boolean }>>
}

export interface PublishSourceRead {
    source: PublishSource
    /** Documents whose text could not be confirmed on this device; the publish leaves them out and says so. */
    unsettled: string[]
}

function assetReader(assets: Pick<AssetStore, 'readBytes'> | null): PublishSource['readAsset'] {
    return async (ref) => {
        if (!assets) return null
        const asset = await assets.readBytes(ref)
        return asset ? { bytes: asset.bytes, name: asset.name, type: asset.type } : null
    }
}

/** Read every document through a reader; unsettled documents are listed, not included. */
export async function readPublishSource(
    reader: PublishReader,
    assets: Pick<AssetStore, 'readBytes'> | null,
    onProgress?: (done: number, total: number) => void,
): Promise<PublishSourceRead> {
    const identities = reader.listDocuments()
    const texts = await reader.readTexts(
        identities.map((d) => d.docId),
        onProgress,
    )
    const documents: PublishDocument[] = []
    const unsettled: string[] = []
    for (const identity of identities) {
        const read = texts.get(identity.docId)
        if (!read || !read.settled) {
            unsettled.push(identity.concept)
            continue
        }
        documents.push({ concept: identity.concept, kind: identity.kind, text: read.text, aliases: [...(identity.aliases ?? [])] })
    }
    return { source: { documents, readAsset: assetReader(assets) }, unsettled }
}

/**
 * A reader over a graph folder's files: `journals/` and `pages/`, identity from the frontmatter
 * (a page's `title`, ADR 0007) or the file name. Every read is a disk read, so it is done once
 * per publish rather than kept.
 */
export function folderPublishReader(adapter: DirectoryAdapter): { read(onProgress?: (done: number, total: number) => void): Promise<PublishReader> } {
    return {
        async read(onProgress) {
            const entries: { subdir: 'journals' | 'pages'; name: string }[] = []
            for (const subdir of ['journals', 'pages'] as const) {
                let listed: { name: string }[] = []
                try {
                    listed = await adapter.list(subdir)
                } catch {
                    // A folder without the subdirectory holds none of that kind.
                }
                for (const entry of listed) if (/\.md$/i.test(entry.name)) entries.push({ subdir, name: entry.name })
            }
            const documents = new Map<string, { identity: PublishReader['listDocuments'] extends () => (infer T)[] ? T : never; text: string }>()
            let done = 0
            for (const entry of entries) {
                onProgress?.(done++, entries.length)
                let text: string
                try {
                    text = (await adapter.read(entry.subdir, entry.name)).text
                } catch {
                    continue
                }
                const stem = entry.name.replace(/\.md$/i, '')
                const fm = parseFrontmatter(text)
                const concept = entry.subdir === 'journals' ? journalConceptOf(entry.name) : conceptOf(fm, stem)
                const docId = `${entry.subdir}/${entry.name}`
                documents.set(docId, {
                    identity: { docId, kind: entry.subdir === 'journals' ? 'journal' : 'page', concept, aliases: aliasesOf(fm) },
                    text,
                })
            }
            onProgress?.(entries.length, entries.length)
            return {
                listDocuments: () => [...documents.values()].map((d) => d.identity),
                readTexts: async (ids) => new Map(ids.map((id) => [id, { text: documents.get(id)?.text ?? '', settled: documents.has(id) }])),
            }
        },
    }
}
