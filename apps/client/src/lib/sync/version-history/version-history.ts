/**
 * Version History for one synced graph, as the workspace and its views use it (ADR 0184): read a
 * document's versions, restore one, list and restore what was deleted, and remove history for good.
 *
 * The Sync Server holds only sealed versions; everything readable happens here, under the graph's
 * keyring. A restore writes the version's text through the store as one ordinary edit, then asks
 * the server to bring back any Deleted Asset the text references, so its images show again.
 */
import type { DeletedItems, VersionList, VersionPolicy, VersionReason } from '@appsoftwareltd/etherpk-shared'
import { keyringReader, type KeyringSource } from '#lib/crypto/index.js'
import type { RestoreVersionOutcome } from '#lib/storage/synced/server-document-store.js'
import type { AssetRestoreOutcome, VersionApi } from './version-api'
import { openVersion, type DocumentVersionPayload, type VersionIdentity } from './version-payload'
import type { VersionRecorder, VersionSnapshot } from './version-recorder'

/** The store operations Version History needs. */
export interface VersionHistoryStore {
    restoreVersion(docId: string, version: VersionSnapshot, options?: { name?: string }): Promise<RestoreVersionOutcome>
    /** The id of the document a name opens now. */
    documentIdOf(name: string): string | undefined
}

export interface VersionHistoryDeps {
    graphId: string
    keyring: KeyringSource
    api: VersionApi
    recorder: VersionRecorder
    store: VersionHistoryStore
    /** A file's name from its sealed metadata, for the deleted list; null when it cannot be read. */
    assetName?: (assetId: string) => Promise<string | null>
}

/** A restore's outcome; `missingAssets` names the files the text references that are gone for good. */
export type RestoreOutcome =
    | { kind: 'restored'; concept: string; missingAssets: string[] }
    /** The graph owner's plan is inactive, so the graph takes no changes: nothing was written. */
    | { kind: 'read-only' }
    | Exclude<RestoreVersionOutcome, { kind: 'restored' }>

export interface DeletedDocumentEntry {
    docId: string
    /** The name it had, from its newest version; null when that version could not be opened. */
    identity: VersionIdentity | null
    deletedAt: string | null
    newestVersionId: string
    removeAt: string | null
}

export interface DeletedAssetEntry {
    assetId: string
    name: string | null
    size: number
    deletedAt: string
    removeAt: string | null
}

export interface DeletedListing {
    documents: DeletedDocumentEntry[]
    assets: DeletedAssetEntry[]
    policy: VersionPolicy
}

export interface VersionHistory {
    /** The id of the document a name opens now: a View is addressed by name, a version by id. */
    documentIdOf(concept: string): string | undefined
    /** The files a version's text references that the server no longer holds. */
    missingAssets(text: string): Promise<string[]>
    /**
     * Make a version of the document `concept` names before an operation that the store does not
     * make itself (a replace-all, removing protection). Synchronous: the text is read now.
     */
    recordBefore(concept: string, reason: VersionReason): void
    /**
     * Keep now the edits waiting for an idle version: the document `concept` names was closed, or,
     * with no name, the person is leaving the page or the graph.
     */
    settle(concept?: string): void
    policy(): Promise<VersionPolicy>
    list(docId: string): Promise<VersionList>
    read(docId: string, versionId: string): Promise<DocumentVersionPayload>
    restore(docId: string, versionId: string, options?: { name?: string }): Promise<RestoreOutcome>
    deleted(): Promise<DeletedListing>
    /** Remove one document's history for good; a Deleted Document goes with it. */
    removeHistory(docId: string): Promise<void>
    /** The Owner's control: all of the graph's history and deleted files, for good. */
    removeAll(): Promise<{ versions: number; assets: number }>
    restoreAsset(assetId: string): Promise<AssetRestoreOutcome>
    removeAssetForGood(assetId: string): Promise<void>
    /**
     * A document was just protected: its earlier versions hold its text readable to every Member,
     * so they are removed, with any not yet sent (ADR 0184).
     */
    documentProtected(docId: string): Promise<void>
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The asset ids a document's text references: every `assets/` path whose file name carries an id,
 * which is how a synced graph writes a reference (`assets/<stem>.<id>.<ext>`). Each once.
 */
export function assetIdsReferencedIn(text: string): string[] {
    const ids = new Set<string>()
    const pattern = new RegExp(`assets/[^\\s)\\]"'|]*?(?:^|[./])(${UUID})(?:\\.[A-Za-z0-9]+)?`, 'gi')
    for (const match of text.matchAll(pattern)) ids.add(match[1].toLowerCase())
    return [...ids]
}

export function createVersionHistory(deps: VersionHistoryDeps): VersionHistory {
    const keyring = keyringReader(deps.keyring)
    const open = async (docId: string, versionId: string, envelope: Uint8Array) =>
        openVersion({ keyring: keyring(), graphId: deps.graphId, docId, versionId, envelope })

    async function read(docId: string, versionId: string): Promise<DocumentVersionPayload> {
        const { envelope } = await deps.api.get(docId, versionId)
        return open(docId, versionId, envelope)
    }

    return {
        documentIdOf: (concept) => deps.store.documentIdOf(concept),
        async missingAssets(text) {
            const ids = assetIdsReferencedIn(text)
            const held = await Promise.all(ids.map((id) => deps.api.assetExists(id).catch(() => true)))
            return ids.filter((_id, index) => !held[index])
        },
        recordBefore(concept, reason) {
            const docId = deps.store.documentIdOf(concept)
            if (docId) void deps.recorder.record(docId, reason).catch(() => undefined)
        },
        settle(concept) {
            if (concept === undefined) return deps.recorder.settle()
            const docId = deps.store.documentIdOf(concept)
            if (docId) deps.recorder.settle(docId)
        },
        policy: () => deps.api.policy(),
        list: (docId) => deps.api.list(docId),
        read,
        async restore(docId, versionId, options) {
            // A restore is a write, which a graph whose owner's plan is inactive refuses. Asked
            // first, so nothing is written here that the Sync Server will not take.
            if ((await deps.api.policy()).removalPaused) return { kind: 'read-only' }
            const version = await read(docId, versionId)
            const outcome = await deps.store.restoreVersion(docId, { text: version.text, identity: version.identity }, options)
            if (outcome.kind !== 'restored') return outcome
            const missingAssets: string[] = []
            for (const assetId of assetIdsReferencedIn(version.text)) {
                const restored = await deps.api.restoreAsset(assetId).catch(() => 'gone' as const)
                if (restored === 'gone') missingAssets.push(assetId)
            }
            // The version made before the restore is sent now, so the list shows it straight away.
            await deps.recorder.flush()
            return { ...outcome, missingAssets }
        },
        async deleted() {
            const listing: DeletedItems = await deps.api.deleted()
            const documents = await Promise.all(
                listing.documents.map(async (entry): Promise<DeletedDocumentEntry> => {
                    const identity = await read(entry.docId, entry.newestVersionId)
                        .then((version) => version.identity)
                        .catch(() => null)
                    return {
                        docId: entry.docId,
                        identity,
                        deletedAt: entry.deletedAt,
                        newestVersionId: entry.newestVersionId,
                        removeAt: entry.removeAt,
                    }
                }),
            )
            const assets = await Promise.all(
                listing.assets.map(async (entry): Promise<DeletedAssetEntry> => ({
                    ...entry,
                    name: (await deps.assetName?.(entry.assetId).catch(() => null)) ?? null,
                })),
            )
            return { documents, assets, policy: listing.policy }
        },
        async removeHistory(docId) {
            await deps.recorder.forget(docId)
            await deps.api.removeDocument(docId)
        },
        removeAll: () => deps.api.removeAll(),
        restoreAsset: (assetId) => deps.api.restoreAsset(assetId),
        removeAssetForGood: (assetId) => deps.api.removeAssetForGood(assetId),
        async documentProtected(docId) {
            await deps.recorder.forget(docId)
            await deps.api.removeDocument(docId)
        },
    }
}
