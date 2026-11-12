/**
 * The open graph's side of a PDF tab (`document/pdf/pdf-service.ts`): its private state, and deleting,
 * renaming and keeping a PDF, which differ by backend. Plain TypeScript over injected parts, so the
 * rules test without a workspace.
 */
import { assetUsageNeedles, planAssetDelete, type ProtectedAssetUsage, quickNoteReferences } from '#lib/document/asset-delete.js'
import { whenDocumentText } from '#lib/document/draft.js'
import type { AssetUsage } from '#lib/document/index-db.js'
import { createFilePdfStateHost } from '#lib/document/pdf/file-pdf-state.js'
import { adoptPdfBookmarks, setPdfBookmarks, type PdfBookmark } from '#lib/document/pdf/pdf-bookmarks.js'
import { pdfDeviceMemory } from '#lib/document/pdf/device-memory.js'
import type { AssetDeleteAnswer, PdfGraphService } from '#lib/document/pdf/pdf-service.js'
import type { PdfStateHost } from '#lib/document/pdf/pdf-state.js'
import { openSyncedPdfState, refusingPdfState } from '#lib/document/pdf/synced-pdf-state.js'
import type { DocumentStore } from '#lib/document/types.js'
import { linkRenameEdits, type LinkRename } from '#lib/document/pdf/rename-links.js'
import { assetFileName, assetHashFromName, assetNameFromRef, displayAssetName, type AssetStore } from '#lib/storage/fs/asset-store.js'
import type { GraphAssetTools } from '#lib/storage/fs/asset-orphans.js'
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'
import { pdfBookmarksFileBinding } from '#lib/storage/fs/pdf-bookmarks-file.js'
import { assetIdFromRef, type ServerAssetStore } from '#lib/storage/synced/server-asset-store.js'
import type { GraphSync } from '#lib/sync/graph-sync.js'

/** What deleting and renaming need of the workspace, whichever backend it opened. */
export interface PdfServiceContext {
    graphId: string
    tools(): GraphAssetTools | null
    /** The index's answer, or null while it is building. */
    usage(needles: readonly string[]): Promise<AssetUsage | null>
    protectedUsage(needles: readonly string[]): Promise<ProtectedAssetUsage>
    /** The text of every [[Quick Note]] the graph holds: a note can reference a file (ADR 0186). */
    quickNoteTexts?(): readonly string[]
    /** The Asset has gone: its Favourite, its Recent, its PDF Bookmarks and its tab go with it. */
    assetGone(target: string, hash: string): void
    /** The Asset has a new identity or name: its Favourite, its Recent and its tab follow. */
    assetRenamed(from: string, to: string, name: string): void
}

/** A link's `#page=` and the like. */
const fragmentOf = (link: string) => (link.includes('#') ? link.slice(link.indexOf('#')) : '')

async function deleteAsset(context: PdfServiceContext, state: PdfStateHost, target: string, hash: string): Promise<AssetDeleteAnswer> {
    const tools = context.tools()
    const id = tools?.identify(`../assets/${target}`) ?? null
    if (!tools || !id) return { deleted: false, reason: 'not-ready', message: 'This graph cannot delete files just now.' }
    const needles = assetUsageNeedles(id)
    const plan = await planAssetDelete({
        usage: () => context.usage(needles),
        protectedUsage: () => context.protectedUsage(needles),
        readiness: () => tools.readyToDeleteBytes(),
        ownReferences: 0,
        quickNoteReferences: () => quickNoteReferences(context.quickNoteTexts?.() ?? [], needles),
    })
    if (plan.lockedProtected || plan.unreadProtected) {
        return { deleted: false, reason: 'not-ready', message: 'Unlock your Protected Documents first: a link inside one would be left broken.' }
    }
    if (!plan.deleteBytes) {
        if (plan.blockedBy === 'used-elsewhere') return { deleted: false, reason: 'linked', documents: [...plan.documents.map((d) => d.concept), ...(plan.quickNotes ? ['Quick notes'] : [])] }
        return { deleted: false, reason: 'not-ready', message: refusalMessage(plan.blockedBy) }
    }
    await tools.remove([id])
    // After the bytes: a failure here leaves a little private state behind, never a missing PDF
    // whose annotations were deleted first.
    await state.forget(hash).catch((error: unknown) => console.warn('[pdf] could not delete the state of a deleted PDF', error))
    context.assetGone(target, hash)
    return { deleted: true }
}

function refusalMessage(blockedBy: string | undefined): string {
    if (blockedBy === 'index-building') return 'It cannot be deleted while this graph is still being read. Try again in a moment.'
    if (blockedBy === 'offline') return 'It cannot be deleted while offline, because another device may have linked to it.'
    if (blockedBy === 'behind') return 'It cannot be deleted until this device has caught up with the graph.'
    return 'It cannot be deleted just now.'
}

/** Apply a rename to every Document that links to the file. */
async function rewriteLinks(store: DocumentStore, concepts: readonly string[], rename: LinkRename): Promise<void> {
    for (const concept of concepts) {
        const document = store.open(concept)
        const text = await whenDocumentText(store, document, concept)
        for (const { from, to, insert } of linkRenameEdits(text, rename)) document.applyChange({ from, to, insert }, 'external')
    }
}

/** The Documents holding a link, from the index and from the Protected Documents that are open. */
function linkingConcepts(usage: AssetUsage, inProtected: ProtectedAssetUsage): string[] {
    return [...new Set([...usage.documents, ...inProtected.documents].map((d) => d.concept))]
}

export interface FolderPdfServiceDeps extends PdfServiceContext {
    adapter: DirectoryAdapter
    assets(): AssetStore | null
    store(): DocumentStore | null
}

export function createFolderPdfService(deps: FolderPdfServiceDeps): PdfGraphService {
    const state = createFilePdfStateHost({ adapter: deps.adapter, memory: pdfDeviceMemory(), graphId: deps.graphId })
    return {
        state,
        backend: 'folder',
        deleteAsset: (target, hash) => deleteAsset(deps, state, target, hash),
        async renameAsset(target, name, oldName) {
            const parsed = assetHashFromName(target)
            const store = deps.store()
            if (!parsed || !store) throw new Error('This file cannot be renamed.')
            const to = assetFileName(name, parsed.hash)
            if (to === target) return { target, name }
            const needles = assetUsageNeedles(target)
            const inProtected = await deps.protectedUsage(needles)
            if (inProtected.locked > 0 || inProtected.unread > 0) {
                throw new Error('Unlock your Protected Documents first: a link inside one could not be updated')
            }
            const usage = await deps.usage(needles)
            if (!usage) throw new Error('This graph is still being read. Try again in a moment')
            const { bytes } = await deps.adapter.readBinary('assets', target)
            await deps.adapter.writeBinary('assets', to, bytes)
            await rewriteLinks(store, linkingConcepts(usage, inProtected), {
                names: (link) => assetNameFromRef(link) === target,
                newTarget: (link) => `../assets/${to}${fragmentOf(link)}`,
                oldNames: [displayAssetName(target), oldName],
                newName: name,
            })
            await deps.adapter.remove('assets', target)
            deps.assets()?.renamed?.(target, to)
            deps.assetRenamed(target, to, name)
            return { target: to, name }
        },
        keptOnDevice: async () => true,
        setKeptOnDevice: async () => {},
    }
}

export interface SyncedPdfServiceDeps extends PdfServiceContext {
    graph: GraphSync
    /** Null for a synced graph opened with no account: there is no person to keep state for. */
    memberKey: string | null
    /** Every current Member, whose private documents go when the PDF goes. */
    memberKeys(): Promise<string[]>
    /**
     * Whether the graph keeps a deleted file for a while (ADR 0184). While it does, a deleted PDF's
     * annotations stay with it, so a restored PDF has them back.
     */
    keepsDeletedFiles?: () => Promise<boolean>
    assets(): ServerAssetStore | null
    store(): DocumentStore | null
}

export function createSyncedPdfStateHost(deps: Pick<SyncedPdfServiceDeps, 'graph' | 'memberKey' | 'memberKeys' | 'keepsDeletedFiles'>): PdfStateHost {
    const { graph, memberKey } = deps
    return {
        async open(hash) {
            if (memberKey === null) return refusingPdfState('This graph has no account behind it, so changes to this PDF cannot be saved.')
            const docId = await graph.pdfStateDocId(memberKey, hash)
            const release = graph.retainDoc(docId)
            const engine = graph.docSync(docId)
            const index = graph.pdfStateIndex(memberKey)
            return openSyncedPdfState({
                doc: engine.doc,
                ready: () => engine.ready(),
                flush: () => engine.flush(),
                release,
                noteContent: () => index.add(hash),
            })
        },
        async forget(hash) {
            if (await deps.keepsDeletedFiles?.()) return
            const keys = new Set(await deps.memberKeys().catch(() => []))
            if (memberKey !== null) keys.add(memberKey)
            for (const key of keys) {
                // Another Member's device reads this as their document being gone. Each is best
                // effort: a leftover private document costs a little storage and shows nowhere.
                await graph.deleteDoc(await graph.pdfStateDocId(key, hash)).catch(() => {})
                graph.pdfStateIndex(key).remove(hash)
            }
        },
    }
}

export function createSyncedPdfService(deps: SyncedPdfServiceDeps): PdfGraphService {
    const state = createSyncedPdfStateHost(deps)
    const refOf = (target: string) => `../assets/${target}`
    const store = () => {
        const assets = deps.assets()
        if (!assets) throw new Error('This graph cannot reach its files just now.')
        return assets
    }
    return {
        state,
        backend: 'synced',
        deleteAsset: (target, hash) => deleteAsset(deps, state, target, hash),
        async renameAsset(target, name, oldName) {
            await store().renameAsset(refOf(target), name)
            // The links keep working by the id they hold, so a link inside a locked Protected Document
            // only keeps its old wording. Those this device can read take the new name.
            const id = assetIdFromRef(refOf(target))
            const needles = id ? assetUsageNeedles(id) : []
            const usage = await deps.usage(needles)
            const live = deps.store()
            if (id && usage && live) {
                const inProtected = await deps.protectedUsage(needles)
                await rewriteLinks(live, linkingConcepts(usage, inProtected), {
                    names: (link) => assetIdFromRef(link) === id,
                    newTarget: (link) => `../assets/${assetFileName(name, id)}${fragmentOf(link)}`,
                    oldNames: [oldName],
                    newName: name,
                })
            }
            deps.assetRenamed(target, target, name)
            return { target, name }
        },
        currentName: (target) => store().currentName(refOf(target)),
        keptOnDevice: (target) => store().keptOnDevice(refOf(target)),
        async setKeptOnDevice(target, keep) {
            await store().setKeptOnDevice(refOf(target), keep)
        },
    }
}


/** A folder graph's PDF Bookmarks, opened with the graph. `notice` says when the file cannot be read. */
export async function openFolderPdfBookmarks(adapter: DirectoryAdapter, notice: (text: string) => void): Promise<void> {
    const binding = await pdfBookmarksFileBinding(adapter)
    setPdfBookmarks(binding.bookmarks, binding.persist)
    if (binding.problem) notice(binding.problem)
}

/**
 * A synced graph's PDF Bookmarks: another of the person's devices' change is adopted as it arrives.
 * Without a member key there is no list of theirs, so a change is refused with `refusal`, as Bookmarks
 * refuse one. Returns what stops listening.
 */
export function openSyncedPdfBookmarks(list: ReturnType<GraphSync['pdfBookmarks']> | null, refusal: string): () => void {
    if (!list) {
        setPdfBookmarks([], async () => {
            throw new Error(refusal)
        })
        return () => {}
    }
    setPdfBookmarks(list.list(), async (change) => list.apply(change))
    return list.observe(() => adoptPdfBookmarks(list.list()))
}

/** A Local Mirror's PDF Bookmarks. Not known without the person's lists, which leaves the file alone. */
export function mirroredPdfBookmarks(own: { pdfBookmarks?: PdfBookmark[] } | undefined): { pdfBookmarks?: PdfBookmark[] } {
    return own?.pdfBookmarks ? { pdfBookmarks: own.pdfBookmarks } : {}
}
