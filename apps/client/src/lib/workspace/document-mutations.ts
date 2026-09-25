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
import { cascadeFor, isScopedBy } from '$lib/document/wikilink/rename'
import { parseViewKey, viewKey } from '$lib/layout/view-ref'
import { conceptKey } from '$lib/storage/fs/identity'

interface DocumentMutationStore {
    planRename(from: string, to: string, referencingDocuments?: number): Promise<RenamePlan>
    renamePage(from: string, to: string, options: RenameOptions): Promise<RenameResult>
    deleteDocument(concept: string): Promise<void>
}

interface DocumentMutationIndex {
    backlinks(concept: string): Promise<readonly Pick<DbBacklinkGroup, 'refs' | 'sourceConcept'>[]>
}

interface DocumentMutationLayout {
    closeView(view: { kind: 'document'; target: string }): void
    openView(view: { kind: 'document'; target: string }, options?: { activate?: boolean }): unknown
    isOpen(view: { kind: 'document'; target: string }): boolean
    /** The arrangement, for which tab is at the front of its Pane. */
    serialize(): {
        model: { regions: Record<string, { panes: { views: { panelId: string }[]; activePanelId: string | null }[] }> }
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
            : `${references} ${references === 1 ? 'document links' : 'documents link'} to it; those links will show as not-yet-created.`
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
    const parts = [`Renamed to "${result.concept}"`]
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
    return `${parts.join(', ')}.`
}

export function createDocumentMutationController(dependencies: DocumentMutationDependencies) {
    /**
     * Count the documents whose BODY references the concept, through the derived index. Reading
     * every source document here was visibly slow on large graphs, while the index already owns
     * the same relationship. A document that only names the concept in its title - one scoped
     * by it (ADR 0083) - is the cascade's to report, not this count's.
     */
    async function referencingDocuments(concept: string): Promise<string[] | undefined> {
        const groups = await dependencies.index()?.backlinks(concept)
        return groups?.filter(referencedInBody).map((group) => group.sourceConcept)
    }

    async function referenceCount(concept: string): Promise<number | undefined> {
        return (await referencingDocuments(concept))?.length
    }

    return {
        referenceCount,

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
            for (const step of moves) {
                if (step.from === step.to) continue
                const front = layout ? isFrontTab(layout, step.from) : false
                layout?.closeView({ kind: 'document', target: step.from })
                layout?.openView({ kind: 'document', target: step.to }, { activate: front })
            }
            dependencies.recents()?.rename(before, after)
            return dependencies.renameFavourite(before, after)
        },

        /**
         * A rename that already happened - a `title` edited outside the app on a Filesystem
         * Backend (ADR 0061). The store has re-keyed the document; here everything keyed by its
         * old name follows: favourites, recents, and the open View, which reopens under the new
         * name over the same buffer.
         */
        async followRename(from: string, to: string): Promise<void> {
            await dependencies.renameFavourite(from, to)
            dependencies.recents()?.rename(from, to)
            const layout = dependencies.layout()
            // Re-keyed in place, as a rename from inside the app is: the tab keeps its place
            // and is fronted only if it was the front one already.
            const wasOpen = layout?.isOpen({ kind: 'document', target: from }) ?? false
            const wasFront = layout ? isFrontTab(layout, from) : false
            layout?.closeView({ kind: 'document', target: from })
            if (wasOpen) layout?.openView({ kind: 'document', target: to }, { activate: wasFront })
        },
    }
}
