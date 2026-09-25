import { describe, expect, it, vi } from 'vitest'

import type { RenamePlan, RenameResult } from '$lib/storage/rename'

import {
    createDocumentMutationController,
    deleteDocumentMessage,
    deleteRefusedAsIncludeMessage,
    renameDocumentSummary,
} from './document-mutations'

const plan: RenamePlan = {
    direct: { from: 'Old', to: 'New', hasDocument: true, merges: false, redirects: false, into: 'New' },
    cascade: [{ from: '[[Old]] Child', to: '[[New]] Child', hasDocument: true, merges: false, redirects: false, into: '[[New]] Child' }],
    referencingDocuments: 2,
    refusal: null,
}

const result: RenameResult = {
    concept: 'New',
    rewritten: 2,
    rewrittenDocuments: ['Essay', 'Diary'],
    cascaded: 1,
    merged: 1,
}

/** A layout with the given documents open in one Pane, `front` at the front. */
function layoutWith(open: string[], front: string | null) {
    const key = (target: string) => `document:${target}`
    return {
        closeView: vi.fn(),
        openView: vi.fn(),
        isOpen: vi.fn((view: { target: string }) => open.includes(view.target)),
        serialize: () => ({
            model: {
                regions: {
                    main: {
                        panes: [{ views: open.map((target) => ({ panelId: key(target) })), activePanelId: front ? key(front) : null }],
                    },
                },
            },
        }),
    }
}

describe('workspace document mutations', () => {
    it('follows a rename that already happened: favourites, recents and the open View', async () => {
        const layout = layoutWith(['Kanban'], 'Kanban')
        const recents = { forget: vi.fn(), rename: vi.fn() }
        const renameFavourite = vi.fn().mockResolvedValue(undefined)
        const controller = createDocumentMutationController({
            store: () => undefined,
            index: () => undefined,
            layout: () => layout,
            recents: () => recents,
            renameFavourite,
        })

        await controller.followRename('Kanban', 'Kanban 2')

        expect(renameFavourite).toHaveBeenCalledWith('Kanban', 'Kanban 2')
        expect(recents.rename).toHaveBeenCalledWith('Kanban', 'Kanban 2')
        expect(layout.closeView).toHaveBeenCalledWith({ kind: 'document', target: 'Kanban' })
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: 'Kanban 2' }, { activate: true })
    })

    it('refuses to delete a document a publication includes, naming where and what to undo', () => {
        expect(deleteRefusedAsIncludeMessage('Site Footer', ['docs'])).toBe(
            '"Site Footer" is used as an include by the publication docs, so it cannot be deleted. Remove it from that publication\'s includes in Settings → Publish, then delete it.',
        )
        expect(deleteRefusedAsIncludeMessage('Site Footer', ['blog', 'docs'])).toBe(
            '"Site Footer" is used as an include by the publications blog and docs, so it cannot be deleted. Remove it from those publications\' includes in Settings → Publish, then delete it.',
        )
    })

    it('keeps the established delete confirmation wording', () => {
        expect(deleteDocumentMessage('Notes', null)).toBe(
            '"Notes" will be removed. Nothing links to it. This cannot be undone.',
        )
        expect(deleteDocumentMessage('Notes', 1)).toBe(
            '"Notes" will be removed. 1 document links to it; those links will show as not-yet-created. This cannot be undone.',
        )
        expect(deleteDocumentMessage('Notes', 3)).toBe(
            '"Notes" will be removed. 3 documents link to it; those links will show as not-yet-created. This cannot be undone.',
        )
    })

    it('keeps rename outcome summaries explicit', () => {
        expect(renameDocumentSummary(result)).toBe(
            'Renamed to "New", 1 scoped document renamed, 1 merged, 2 documents updated.',
        )
        expect(
            renameDocumentSummary({
                concept: 'New',
                rewritten: 0,
                rewrittenDocuments: [],
                cascaded: 0,
                merged: 0,
            }),
        ).toBe('Renamed to "New".')
    })

    it('plans, renames and deletes through explicit collaborators', async () => {
        const store = {
            planRename: vi.fn().mockResolvedValue(plan),
            renamePage: vi.fn().mockResolvedValue(result),
            deleteDocument: vi.fn().mockResolvedValue(undefined),
        }
        // Three groups link to Old; the third only carries it in its title (`[[Old]] Child`,
        // scoped by it - ADR 0083). The cascade retitles that one, so the body-rewrite count
        // the dialog shows must not include it.
        const index = {
            backlinks: vi.fn().mockResolvedValue([
                { sourceConcept: 'Essay', refs: [{ kind: 'prose' }] },
                { sourceConcept: 'Diary', refs: [{ kind: 'title' }, { kind: 'block' }] },
                { sourceConcept: '[[Old]] Child', refs: [{ kind: 'title' }] },
            ]),
        }
        const layout = layoutWith([], null)
        const recents = {
            forget: vi.fn(),
            rename: vi.fn(),
        }
        const renameFavourite = vi.fn().mockResolvedValue(undefined)
        const controller = createDocumentMutationController({
            store: () => store,
            index: () => index,
            layout: () => layout,
            recents: () => recents,
            renameFavourite,
        })

        await expect(controller.planRename('Old', 'New')).resolves.toBe(plan)
        expect(index.backlinks).toHaveBeenCalledWith('Old')
        expect(store.planRename).toHaveBeenCalledWith('Old', 'New', 2)

        await expect(controller.rename('Old', plan, 'New', 'rewrite')).resolves.toBe(result)
        // The rewrite hands the store the documents the index says reference the concept, body
        // links only: the scoped page is the cascade's, not a body to rewrite.
        expect(store.renamePage).toHaveBeenCalledWith('Old', 'New', { strategy: 'rewrite', referencing: ['Essay', 'Diary'] })
        expect(renameFavourite).toHaveBeenCalledWith('Old', 'New')
        expect(recents.rename).toHaveBeenCalledWith('Old', 'New')
        expect(layout.closeView).toHaveBeenNthCalledWith(1, {
            kind: 'document',
            target: 'Old',
        })
        expect(layout.closeView).toHaveBeenNthCalledWith(2, {
            kind: 'document',
            target: '[[Old]] Child',
        })
        // Neither document was open, so nothing opens: a rename never navigates.
        expect(layout.openView).not.toHaveBeenCalled()

        await expect(controller.delete('New')).resolves.toBe(true)
        expect(store.deleteDocument).toHaveBeenCalledWith('New')
        expect(layout.closeView).toHaveBeenLastCalledWith({
            kind: 'document',
            target: 'New',
        })
        expect(recents.forget).toHaveBeenCalledWith('New')
    })

    it('closes the vacated Views by outcome, even when handed a stale preview plan', async () => {
        // Rename confirmed inside the preview debounce: the plan was computed for the unchanged
        // name, so every step reads from === to. The store still renamed; the Views must close.
        const stale: RenamePlan = {
            direct: { from: 'Old', to: 'Old', hasDocument: false, merges: false, redirects: false, into: 'Old' },
            cascade: [{ from: '[[Old]] Child', to: '[[Old]] Child', hasDocument: true, merges: false, redirects: false, into: '[[Old]] Child' }],
            referencingDocuments: 2,
            refusal: null,
        }
        const layout = layoutWith(['Old'], 'Old')
        const controller = createDocumentMutationController({
            store: () => ({
                planRename: vi.fn(),
                renamePage: vi.fn().mockResolvedValue({ concept: 'New', rewritten: 2, cascaded: 1, merged: 0 }),
                deleteDocument: vi.fn(),
            }),
            index: () => undefined,
            layout: () => layout,
            recents: () => null,
            renameFavourite: vi.fn().mockResolvedValue(undefined),
        })

        await controller.rename('Old', stale, 'New', 'rewrite')

        expect(layout.closeView.mock.calls.map(([v]) => v.target).sort()).toEqual(['Old', '[[Old]] Child'].sort())
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: 'New' }, { activate: true })
    })

    it('closes nothing when the rename changed nothing', async () => {
        const layout = layoutWith([], null)
        const controller = createDocumentMutationController({
            store: () => ({
                planRename: vi.fn(),
                renamePage: vi.fn().mockResolvedValue({ concept: 'Old', rewritten: 0, cascaded: 0, merged: 0 }),
                deleteDocument: vi.fn(),
            }),
            index: () => undefined,
            layout: () => layout,
            recents: () => null,
            renameFavourite: vi.fn().mockResolvedValue(undefined),
        })
        await controller.rename('Old', plan, 'Old', 'rewrite')
        expect(layout.closeView).not.toHaveBeenCalled()
    })

    it('re-keys open Views in place and never navigates (ADR 0065)', async () => {
        // "Old" is open but not active; "[[Old]] Child" is open AND active; the user is looking
        // at Child. After the rename Child must still be the active one, Old must be back in the
        // background under its new name, and nothing that was closed must open.
        const layout = layoutWith(['Old', '[[Old]] Child'], '[[Old]] Child')
        const controller = createDocumentMutationController({
            store: () => ({
                planRename: vi.fn(),
                renamePage: vi.fn().mockResolvedValue({ concept: 'New', rewritten: 1, cascaded: 1, merged: 0 }),
                deleteDocument: vi.fn(),
            }),
            index: () => undefined,
            layout: () => layout,
            recents: () => null,
            renameFavourite: vi.fn().mockResolvedValue(undefined),
        })

        await controller.rename('Old', plan, 'New', 'rewrite')

        expect(layout.closeView.mock.calls.map(([v]) => v.target).sort()).toEqual(['Old', '[[Old]] Child'].sort())
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: 'New' }, { activate: false })
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: '[[New]] Child' }, { activate: true })
        expect(layout.openView).toHaveBeenCalledTimes(2)
    })

    it('carries an open Draft scoped by the renamed concept, which no plan can know about', async () => {
        // "[[Old]] Idea" has no document - it is a Draft someone opened from a link - so the
        // plan's cascade (documents only) does not list it. Its tab must still follow.
        const layout = layoutWith(['[[Old]] Idea', 'Notes'], 'Notes')
        const controller = createDocumentMutationController({
            store: () => ({
                planRename: vi.fn(),
                renamePage: vi.fn().mockResolvedValue({ concept: 'New', rewritten: 1, cascaded: 0, merged: 0 }),
                deleteDocument: vi.fn(),
            }),
            index: () => undefined,
            layout: () => layout,
            recents: () => null,
            renameFavourite: vi.fn().mockResolvedValue(undefined),
        })
        const bare: RenamePlan = { ...plan, cascade: [] }
        await controller.rename('Old', bare, 'New', 'rewrite')
        expect(layout.closeView).toHaveBeenCalledWith({ kind: 'document', target: '[[Old]] Idea' })
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: '[[New]] Idea' }, { activate: false })
    })

    it('follows a concept moved by its only link: the Draft over it, and over anything scoped by it', async () => {
        const layout = layoutWith(['Old', 'Really [[Complex [[Old]]]] Thing', 'Notes'], 'Notes')
        const recents = { forget: vi.fn(), rename: vi.fn() }
        const renameFavourite = vi.fn().mockResolvedValue(undefined)
        const controller = createDocumentMutationController({
            store: () => ({ planRename: vi.fn(), renamePage: vi.fn(), deleteDocument: vi.fn() }),
            index: () => undefined,
            layout: () => layout,
            recents: () => recents,
            renameFavourite,
        })
        await controller.followConceptMove('Old', 'New')
        expect(layout.closeView.mock.calls.map(([v]) => v.target).sort()).toEqual(
            ['Old', 'Really [[Complex [[Old]]]] Thing'].sort(),
        )
        expect(layout.openView).toHaveBeenCalledWith({ kind: 'document', target: 'New' }, { activate: false })
        expect(layout.openView).toHaveBeenCalledWith(
            { kind: 'document', target: 'Really [[Complex [[New]]]] Thing' },
            { activate: false },
        )
        // Notes is untouched.
        expect(layout.closeView).not.toHaveBeenCalledWith({ kind: 'document', target: 'Notes' })
        expect(recents.rename).toHaveBeenCalledWith('Old', 'New')
        expect(renameFavourite).toHaveBeenCalledWith('Old', 'New')
    })

    it('opens nothing when the renamed document was not open', async () => {
        const layout = layoutWith([], null)
        const controller = createDocumentMutationController({
            store: () => ({
                planRename: vi.fn(),
                renamePage: vi.fn().mockResolvedValue({ concept: 'New', rewritten: 1, cascaded: 0, merged: 0 }),
                deleteDocument: vi.fn(),
            }),
            index: () => undefined,
            layout: () => layout,
            recents: () => null,
            renameFavourite: vi.fn().mockResolvedValue(undefined),
        })
        await controller.rename('Old', plan, 'New', 'rewrite')
        expect(layout.openView).not.toHaveBeenCalled()
    })

    it('preserves no-op behaviour before the graph store exists', async () => {
        const controller = createDocumentMutationController({
            store: () => undefined,
            index: () => undefined,
            layout: () => undefined,
            recents: () => null,
            renameFavourite: vi.fn(),
        })

        await expect(controller.planRename('Old', 'New')).resolves.toBeNull()
        await expect(controller.delete('Old')).resolves.toBe(false)
    })
})
