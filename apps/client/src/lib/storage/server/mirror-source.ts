/**
 * The [[Local Mirror]]'s view of a live synced graph: a {@link MirrorSource} over the
 * ServerDocumentStore and the graph's [[Asset]] store.
 *
 * It exists as its own module rather than inside the workspace component so that the whole path
 * the mirror actually runs - the store's cache-seeded batch read, its registry confirmation, real
 * asset bytes - is exercised by unit tests over a real GraphSync. The workspace's own wiring used
 * to be the only place these were joined up, which is why a document that mirrored without its
 * body was invisible until it reached a user's folder.
 */
import type { AssetStore } from '$lib/storage/fs/asset-store'
import { splitNameExt } from '$lib/storage/fs/asset-store'
import { publishSlug } from '$lib/document/wikilink'
import { assetIdFromRef } from './server-asset-store'

import type { MirrorAssetResult, MirrorMetadata, MirrorSource } from './local-mirror'
import type { ServerDocumentStore } from './server-document-store'

export interface MirrorSourceDeps {
    store: ServerDocumentStore
    /** The graph's asset store. Without one the mirror writes documents and no assets. */
    assets?: Pick<AssetStore, 'readBytes'> | null
    /**
     * Every [[Asset]] the graph holds, by id. The blind server enumerates these without reading
     * anything (ADR 0027), which is what lets the mirror ask "does the graph hold this?" instead
     * of guessing from a regex over document text - and what lets it back up an
     * [[Orphaned Asset]] too. `storage/server/asset-orphans.ts` supplies it.
     */
    listAssetIds?: (() => Promise<string[]>) | null
    /** The [[Graph Name]], [[Graph Settings]] and [[Quick Note]]s as they stand; all travel with the folder. */
    metadata?: () => MirrorMetadata | undefined
    /**
     * Subscribe to [[Graph Name]] and [[Graph Settings]] changes. They live in the root doc's
     * `meta` map rather than the registry, so the store's own change signal never mentions them
     * and `etherpk/settings.json` would otherwise sit stale until something else moved.
     */
    onMetadataChange?: (listener: () => void) => () => void
}

/**
 * What to call an asset nothing references: the same `<stem>.<id>.<ext>` shape an upload mints,
 * built from the name its own metadata carries, so the folder reads the same either way.
 */
function mirrorAssetFileName(assetId: string, originalName: string): string {
    const { stem, ext } = splitNameExt(originalName)
    const slug = publishSlug(stem) || 'asset'
    return ext ? `${slug}.${assetId}.${ext}` : `${slug}.${assetId}`
}

export function createMirrorSource({
    store,
    assets,
    listAssetIds,
    metadata,
    onMetadataChange,
}: MirrorSourceDeps): MirrorSource {
    return {
        listDocuments: () => store.listIdentities(),
        readTexts: (docIds, onProgress) => store.readTexts(docIds, { onProgress }),
        confirmRegistry: () => store.confirmRegistry(),
        metadata,
        ...(assets && listAssetIds
            ? {
                  async listGraphAssets(): Promise<readonly string[] | null> {
                      try {
                          return await listAssetIds()
                      } catch {
                          // Offline, or the server would not answer. The folder is left alone
                          // rather than reconciled against a list that could not be fetched.
                          return null
                      }
                  },
                  assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                  async fetchAsset(assetId: string): Promise<MirrorAssetResult> {
                      // Addressed by identity alone, which the asset store resolves as readily as
                      // a document's reference - an asset nothing references has no other name.
                      const asset = await assets.readBytes(`../assets/${assetId}`)
                      if (!asset) return 'unavailable'
                      return { bytes: asset.bytes, fileName: mirrorAssetFileName(assetId, asset.name) }
                  },
              }
            : {}),
        onChange(listener) {
            const detachStore = store.onChange(listener)
            // Unnamed, because a metadata change is not one document's: it takes the full pass
            // that writes `etherpk/`.
            const detachMeta = onMetadataChange?.(() => listener())
            return () => {
                detachStore()
                detachMeta?.()
            }
        },
    }
}
