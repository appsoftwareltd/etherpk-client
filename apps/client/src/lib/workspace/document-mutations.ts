/**
 * Workspace policy for renaming and deleting documents.
 *
 * Both storage backends expose the same mutation seam. Keeping the orchestration here makes the
 * Svelte workspace responsible for dialog state while this framework-free controller owns the
 * cross-service consequences: favourites, recents and open Views follow the document mutation.
 */
import type { RenameLinkStrategy, RenameOptions, RenamePlan, RenameResult } from '$lib/storage/rename'
import { renameSteps } from '$lib/storage/rename'
import { type DbBacklinkGroup, referencedInBody } from '$lib/document/index-db'
import { reachedWithin } from '$lib/reached-within'
import { cascadeFor, isScopedBy } from '$lib/document/wikilink/rename'
import { documentsRenamed, handOverBoard, type RenamedDocument } from '$lib/kanban/board-actions'
import { KANBAN_VIEW_KIND } from '$lib/kanban/board-model'
import { parseViewKey, viewKey } from '$lib/layout/view-ref'
import { conceptKey } from '$lib/storage/fs/identity'

interface DocumentMutationStore {
    planRename(from: string, to: string, referencingDocuments?: number): Promise<RenamePlan>
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    deleteDocument(concept: string): Promise<void>
}

interface DocumentMutationIndex {
    backlinks(concept: string): Promise<readonly Pick<DbBacklinkGroup, 'refs' | 'sourceConcept' | 'bodyNames'>[]>
    /** Resolves once every change the index has seen is in it (`RemoteGraphIndex.settled`). */
    settled?(): Promise<void>
}

/** One source document's backlinks, as a rename reads them. */
type MutationBacklinkGroup = Pick<DbBacklinkGroup, 'refs' | 'sourceConcept' | 'bodyNames'>

/**
 * How long a rename waits for the [[Derived Index]] to take in the changes it has already seen
 * before asking it which documents link to a name. The index trails the store by a debounce and an
 * ingest, and by a whole rebuild after a change to the graph's names. Asked too early it leaves out
 * documents that link by the name, and a synced rewrite reads only the documents it names.
 */
export const INDEX_CATCH_UP_MS = 10_000

/**
 * How long a rename's preview waits for the index before showing what it has. The preview is
 * redrawn as a name is typed and only informs: the rename itself plans again and waits the full
 * {@link INDEX_CATCH_UP_MS}, so a figure a moment stale here changes nothing that is written.
 */
export const PREVIEW_CATCH_UP_MS = 1_500

interface DocumentMutationLayout {
    closeView(view: { kind: string; target: string }): void
    openView(view: { kind: string; target: string }, options?: { activate?: boolean; paneId?: string }): unknown
    isOpen(view: { kind: string; target: string }): boolean
    /** The arrangement, for which tab is at the front of its Pane. */
    serialize(): {
        model: { regions: Record<string, { panes: { id: string; views: { panelId: string }[]; activePanelId: string | null }[] }> }
    }
}

/** Every document View open anywhere, by target - Drafts included, which is the point. */
function openDocumentTargets(layout: DocumentMutationLayout): string[] {
    const out: string[] = []
    for (const region of Object.values(layout.serialize().model.regions)) {
        for (const pane of region.panes) {
            for (const v of pane.views) {
                const ref = parseViewKey(v.panelId)
                if (ref.kind === 'document') out.push(ref.target)
            }
        }
    }
    return out
}

/** An open [[Kanban Board]]: its concept, the Pane holding it, and whether it is that Pane's front tab. */
interface OpenBoard {
    target: string
    paneId: string
    front: boolean
}

/** Every board open anywhere, read before a rename moves anything. */
function openBoards(layout: DocumentMutationLayout): OpenBoard[] {
    const out: OpenBoard[] = []
    for (const region of Object.values(layout.serialize().model.regions)) {
        for (const pane of region.panes) {
            for (const v of pane.views) {
                const ref = parseViewKey(v.panelId)
                if (ref.kind === KANBAN_VIEW_KIND) out.push({ target: ref.target, paneId: pane.id, front: pane.activePanelId === v.panelId })
            }
        }
    }
    return out
}

/**
 * The name a concept has after `from` became `to`: `to` for the concept itself, whatever the
 * case it was written in, and the rewritten name for one `from` scopes (ADR 0083). Undefined for
 * a concept the move leaves alone.
 */
function movedConcept(concept: string, from: string, to: string): string | undefined {
    if (conceptKey(concept) === conceptKey(from)) return to
    return cascadeFor([concept], from, to)[0]?.to
}

/**
 * Re-key each board in `boards` whose concept `moved` names a new name for (ADR 0113): the board
 * is retitled in place, in the same Pane, and one at the front stays at the front. The new board
 * opens before the old one closes, so a Pane the board had to itself is never emptied and
 * removed from under it. It starts from the old board's state (board-actions.ts), so the boards
 * are told of any documents renamed first, and the old board's Task Detail has followed them.
 */
function moveBoards(layout: DocumentMutationLayout, boards: readonly OpenBoard[], moved: (concept: string) => string | undefined): void {
    for (const board of boards) {
        const to = moved(board.target)
        if (to === undefined || to === board.target) continue
        handOverBoard(board.target, to)
        layout.openView({ kind: KANBAN_VIEW_KIND, target: to }, { activate: board.front, paneId: board.paneId })
        layout.closeView({ kind: KANBAN_VIEW_KIND, target: board.target })
    }
}

/** Whether the document's tab is the front one of the Pane holding it. */
function isFrontTab(layout: DocumentMutationLayout, target: string): boolean {
    const key = viewKey({ kind: 'document', target })
    for (const region of Object.values(layout.serialize().model.regions)) {
        for (const pane of region.panes) {
            if (pane.views.some((v) => v.panelId === key)) return pane.activePanelId === key
        }
    }
    return false
}

interface DocumentMutationRecents {
    forget(concept: string): void
    rename(from: string, to: string): void
}

export interface DocumentMutationDependencies {
    store(): DocumentMutationStore | undefined
    index(): DocumentMutationIndex | undefined
    layout(): DocumentMutationLayout | undefined
    recents(): DocumentMutationRecents | null
    renameFavourite(from: string, to: string): Promise<void>
}

/** The exact confirmation copy for a destructive document removal. */
export function deleteDocumentMessage(concept: string, references: number | null): string {
    const links =
        references === null || references === 0
            ? 'Nothing links to it.'
            : `${references} ${references === 1 ? 'document links' : 'documents link'} to it - those links will show as not-yet-created.`
    return `"${concept}" will be removed. ${links} This cannot be undone.`
}

/**
 * Why a document a publication names under `includes:` (ADR 0082) is not deleted: a site
 * would silently lose its footer or scripts, and the publication page would still name a page
 * that no longer exists. The include reference is the thing to remove first, and this says where.
 */
export function deleteRefusedAsIncludeMessage(concept: string, publications: readonly string[]): string {
    const several = publications.length > 1
    const names = several ? `${publications.slice(0, -1).join(', ')} and ${publications[publications.length - 1]}` : publications[0]
    return `"${concept}" is used as an include by the ${several ? 'publications' : 'publication'} ${names}, so it cannot be deleted. Remove it from ${several ? "those publications'" : "that publication's"} includes in Settings → Publish, then delete it.`
}

/** Report every non-trivial effect of a completed rename. */
export function renameDocumentSummary(result: RenameResult): string {
    // A renamed alias leaves the page's title as it was (ADR 0065, amended 2026-10-04).
    const parts = [result.aliasOf === null ? `Renamed to "${result.concept}"` : `"${result.aliasOf}" now answers to "${result.concept}"`]
    if (result.cascaded > 0) {
        parts.push(
            `${result.cascaded} scoped ${result.cascaded === 1 ? 'document' : 'documents'} renamed`,
        )
    }
    if (result.merged > 0) parts.push(`${result.merged} merged`)
    if (result.rewritten > 0) {
        parts.push(
            `${result.rewritten} ${result.rewritten === 1 ? 'document' : 'documents'} updated`,
        )
    }
    // Scoped aliases the cascade carried along (ADR 0038, amended 2026-10-03). A renamed alias's
    // page is the first part's, so it is not counted again here.
    const aliasHolders = result.aliasesRewritten.filter(
        (holder) => result.aliasOf === null || conceptKey(holder) !== conceptKey(result.aliasOf),
    ).length
    if (aliasHolders > 0) {
        parts.push(`aliases updated in ${aliasHolders} ${aliasHolders === 1 ? 'document' : 'documents'}`)
    }
    return `${parts.join(', ')}.`
}

export function createDocumentMutationController(dependencies: DocumentMutationDependencies) {
    /** Whether the index has taken in every change it has seen, waiting up to `waitMs`. */
    async function indexCaughtUp(index: DocumentMutationIndex, waitMs: number): Promise<boolean> {
        return index.settled ? reachedWithin(index.settled(), waitMs) : true
    }

    /**
     * The index's backlinks for `concept` once it has taken in every change it has seen, or null
     * when there is no index or it has not caught up within {@link INDEX_CATCH_UP_MS}. Null is "the
     * index cannot say", never "nothing links here": each caller decides what not knowing means.
     * For what is written, or decided, from the answer.
     */
    async function backlinksCaughtUp(concept: string): Promise<readonly MutationBacklinkGroup[] | null> {
        const index = dependencies.index()
        if (!index || !(await indexCaughtUp(index, INDEX_CATCH_UP_MS))) return null
        return index.backlinks(concept)
    }

    /**
     * The index's backlinks for `concept` for a preview: after at most {@link PREVIEW_CATCH_UP_MS}
     * of waiting for it to catch up, as it stands. Null when there is no index.
     */
    async function previewBacklinks(concept: string): Promise<readonly MutationBacklinkGroup[] | null> {
        const index = dependencies.index()
        if (!index) return null
        await indexCaughtUp(index, PREVIEW_CATCH_UP_MS)
        return index.backlinks(concept)
    }

    /**
     * The documents whose BODY links to `name` by that very name: the page's other names share its
     * backlinks, and the rewrite leaves them be. A document that only names it in its title, one
     * scoped by it (ADR 0083), is the cascade's to report, not this list's.
     */
    function bodyReferences(groups: readonly MutationBacklinkGroup[], name: string): string[] {
        return groups.filter((group) => referencedInBody(group, name)).map((group) => group.sourceConcept)
    }

    /**
     * The documents a rewrite of `concept` has to read, through the derived index: reading every
     * source document here was visibly slow on large graphs, while the index already owns the same
     * relationship. Undefined when the index cannot say: the store then reads every document,
     * which is slower and misses none.
     */
    async function referencingDocuments(concept: string): Promise<string[] | undefined> {
        const groups = await backlinksCaughtUp(concept)
        return groups ? bodyReferences(groups, concept) : undefined
    }

    /** The preview's "N documents link to X". Undefined without an index: the store counts. */
    async function referenceCount(concept: string): Promise<number | undefined> {
        const groups = await previewBacklinks(concept)
        return groups ? bodyReferences(groups, concept).length : undefined
    }

    return {
        referenceCount,
        backlinksCaughtUp,
        previewBacklinks,

        async planRename(concept: string, candidate: string): Promise<RenamePlan | null> {
            const store = dependencies.store()
            if (!store) return null
            return store.planRename(concept, candidate, await referenceCount(concept))
        },

        async delete(concept: string): Promise<boolean> {
            const store = dependencies.store()
            if (!store) return false
            await store.deleteDocument(concept)
            dependencies.layout()?.closeView({ kind: 'document', target: concept })
            dependencies.recents()?.forget(concept)
            return true
        },

        async rename(
            concept: string,
            plan: RenamePlan | null,
            next: string,
            strategy: RenameLinkStrategy,
        ): Promise<RenameResult> {
            const store = dependencies.store()
            if (!store) throw new Error('No document store is available for rename.')
            const layout = dependencies.layout()

            // A rename never navigates (ADR 0065): it changes neither which documents are open
            // nor which is in front. Every open View of a document the rename moves - the one
            // named, and the cascade beneath it - is re-keyed to its new name in place, and one
            // that was the front tab of its Pane stays in front. Read before the store moves
            // anything, since afterwards the old names are gone. The `from` names come from the
            // plan, which may be the dialog's last preview - Rename confirmed inside the preview
            // debounce hands over one computed for the unchanged name - but the cascade SET
            // depends only on `from`, so it still says which documents move; the `to` names
            // are recomputed.
            // The plan's cascade covers documents; an open [[Draft]] over a pageless concept
            // scoped by this one is in neither registry nor index, and follows too - it holds
            // nothing (content would have promoted it), so re-keying it is lossless.
            const steps = plan ? renameSteps(plan) : []
            const openScoped = layout ? openDocumentTargets(layout).filter((t) => isScopedBy(t, concept)) : []
            const froms = [...new Set([concept, ...steps.map((s) => s.from), ...openScoped])]
            const state = froms.map((from) => ({
                from,
                open: layout?.isOpen({ kind: 'document', target: from }) ?? false,
                active: layout ? isFrontTab(layout, from) : false,
            }))
            const boards = layout ? openBoards(layout) : []

            // The index says which documents the rewrite has to read; the store brings those
            // current before it splices and refuses if one cannot be (ADR 0038, note of
            // 2026-09-20). Without an index the store reads every document instead.
            const referencing = strategy === 'rewrite' ? await referencingDocuments(concept) : undefined
            const result = await store.renamePage(concept, next, { strategy, referencing })
            await dependencies.renameFavourite(concept, result.concept)
            dependencies.recents()?.rename(concept, result.concept)

            if (conceptKey(result.concept) === conceptKey(concept)) return result
            const renamedTo = new Map<string, string>([[concept, result.concept]])
            for (const step of cascadeFor(froms, concept, result.concept)) renamedTo.set(step.from, step.to)
            // A cascaded document that landed on another document's alias lives on under THAT
            // document's title; the plan knows (`into`), and can be trusted when it is the one
            // the result came from rather than a stale preview.
            if (plan && conceptKey(plan.direct.into) === conceptKey(result.concept)) {
                for (const step of steps) if (step.into !== step.to) renamedTo.set(step.from, step.into)
            }
            for (const entry of state) {
                const to = renamedTo.get(entry.from)
                if (!to || to === entry.from) continue
                layout?.closeView({ kind: 'document', target: entry.from })
                if (entry.open) layout?.openView({ kind: 'document', target: to }, { activate: entry.active })
            }
            // The name each document the rename moved has now: one planned or open by its entry,
            // any other the renamed concept scopes by the cascade rule. A board's Task Detail
            // showing one follows it (board-actions.ts).
            const renamedDocument: RenamedDocument = (document) => {
                for (const [from, to] of renamedTo) if (conceptKey(from) === conceptKey(document)) return to
                return movedConcept(document, concept, result.concept)
            }
            documentsRenamed(renamedDocument)
            if (layout) moveBoards(layout, boards, (target) => movedConcept(target, concept, result.concept))
            return result
        },

        /**
         * The only link naming a pageless concept was edited, so the concept has moved with it
         * and nothing was asked (ADR 0065). Whatever was keyed by the old name - an open
         * [[Draft]] over it or over a concept scoped by it, its favourite, its recents entry -
         * follows, exactly as a confirmed rename would carry it: a Draft has nothing to stand on
         * once the link that defined its concept says something else.
         */
        followConceptMove(before: string, after: string): Promise<void> {
            const layout = dependencies.layout()
            const targets = layout
                ? openDocumentTargets(layout).filter((t) => conceptKey(t) === conceptKey(before) || isScopedBy(t, before))
                : []
            // The concept itself, then everything scoped by it (the cascade rule matches the
            // bracketed form, so the bare name is mapped by hand).
            const moves = [
                ...targets.filter((t) => conceptKey(t) === conceptKey(before)).map((from) => ({ from, to: after })),
                ...cascadeFor(targets, before, after),
            ]
            const boards = layout ? openBoards(layout) : []
            for (const step of moves) {
                if (step.from === step.to) continue
                const front = layout ? isFrontTab(layout, step.from) : false
                layout?.closeView({ kind: 'document', target: step.from })
                layout?.openView({ kind: 'document', target: step.to }, { activate: front })
            }
            // A pageless concept moved with its only link: no document was renamed.
            if (layout) moveBoards(layout, boards, (target) => movedConcept(target, before, after))
            dependencies.recents()?.rename(before, after)
            return dependencies.renameFavourite(before, after)
        },

        /**
         * A rename that already happened - a `title` edited outside the app on a Filesystem
         * Backend (ADR 0061), or a synced document renamed on another device or by an agent. The
         * store has re-keyed the document; here everything keyed by its old name follows: the
         * open View, which reopens under the new name over the same document, recents and
         * favourites.
         */
        async followRename(from: string, to: string): Promise<void> {
            const layout = dependencies.layout()
            // Re-keyed in place, as a rename from inside the app is: the tab keeps its place
            // and is fronted only if it was the front one already. Done before the favourite
            // write is awaited, so a caller that goes on to save the layout saves the new name.
            const wasOpen = layout?.isOpen({ kind: 'document', target: from }) ?? false
            const wasFront = layout ? isFrontTab(layout, from) : false
            const boards = layout ? openBoards(layout) : []
            layout?.closeView({ kind: 'document', target: from })
            if (wasOpen) layout?.openView({ kind: 'document', target: to }, { activate: wasFront })
            // The store reports each document it moved, scoped ones included, so only the board
            // over this one concept, and a Task Detail showing this one document, follow here.
            const renamedDocument: RenamedDocument = (document) => (conceptKey(document) === conceptKey(from) ? to : undefined)
            documentsRenamed(renamedDocument)
            if (layout) moveBoards(layout, boards, renamedDocument)
            dependencies.recents()?.rename(from, to)
            await dependencies.renameFavourite(from, to)
        },
    }
}
