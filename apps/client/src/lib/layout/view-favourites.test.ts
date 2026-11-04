import { describe, expect, it, vi } from 'vitest'

import { createViewRegistry } from './registry'
import type { ViewRegistry } from './types'
import { createViewFavourites, type ViewFavouriteAvailability } from './view-favourites'

const Stub = (() => {}) as never

/** The registry as the workspace fills it from the manifests: a board per concept, one Graph Kanban. */
function registryWithBoards(): ViewRegistry {
    const registry = createViewRegistry()
    registry.register({ kind: 'kanban.board', component: Stub, title: (view) => `Kanban: ${view.target}`, icon: 'kanban.kanban', conceptTarget: true, favourite: true })
    registry.register({ kind: 'kanban.whole', component: Stub, title: () => 'Graph Kanban', icon: 'kanban.kanban', soleTarget: 'whole', favourite: true })
    registry.register({ kind: 'graph-view.local', component: Stub, title: () => 'Graph View', soleTarget: 'local' })
    registry.register({ kind: 'document', component: Stub })
    return registry
}

function favourites(availability: (kind: string) => ViewFavouriteAvailability = () => ({ state: 'on' })) {
    return createViewFavourites({ registry: registryWithBoards(), availability })
}

describe('view favourites', () => {
    it('names the favourite a View is, when its kind can be one', () => {
        const views = favourites()
        expect(views.favouriteOf({ kind: 'kanban.board', target: 'Garden' })).toEqual({ kind: 'kanban.board', concept: 'Garden' })
        expect(views.favouriteOf({ kind: 'kanban.whole', target: 'whole' })).toEqual({ kind: 'kanban.whole' })
    })

    it('names none for a kind that cannot be a favourite, a document, or an unknown kind', () => {
        const views = favourites()
        expect(views.favouriteOf({ kind: 'graph-view.local', target: 'local' })).toBeNull()
        // A document is favourited by its concept, through the document rows.
        expect(views.favouriteOf({ kind: 'document', target: 'Garden' })).toBeNull()
        expect(views.favouriteOf({ kind: 'maps.map', target: 'Garden' })).toBeNull()
        // Not the kind's one View: nothing the Favourites list could open again.
        expect(views.favouriteOf({ kind: 'kanban.whole', target: 'other' })).toBeNull()
    })

    it('describes a favourite by its tab title and icon, and opens the View it names', () => {
        const views = favourites()
        expect(views.describe({ kind: 'kanban.board', concept: 'Garden' })).toEqual({
            title: 'Kanban: Garden',
            icon: 'kanban.kanban',
            view: { kind: 'kanban.board', target: 'Garden' },
        })
        expect(views.describe({ kind: 'kanban.whole' })).toEqual({
            title: 'Graph Kanban',
            icon: 'kanban.kanban',
            view: { kind: 'kanban.whole', target: 'whole' },
        })
    })

    it('still opens a favourite whose extension is switched off, saying so: its tab offers to switch it on', () => {
        const views = favourites(() => ({ state: 'off', name: 'Kanban' }))
        expect(views.describe({ kind: 'kanban.whole' })).toEqual({
            title: 'Graph Kanban',
            icon: 'kanban.kanban',
            view: { kind: 'kanban.whole', target: 'whole' },
            note: 'Kanban is switched off on this device',
        })
    })

    it('keeps a favourite whose extension is not here, opening nothing and saying why', () => {
        const views = favourites(() => ({ state: 'missing' }))
        expect(views.describe({ kind: 'kanban.board', concept: 'Garden' })).toEqual({
            title: 'Kanban: Garden',
            icon: 'kanban.kanban',
            view: null,
            note: 'Its extension is not installed on this device',
        })
        // Never declared here at all: no title to borrow, so the stored kind and concept stand in.
        expect(views.describe({ kind: 'maps.map', concept: 'Garden' })).toEqual({
            title: 'maps.map: Garden',
            view: null,
            note: 'Its extension is not installed on this device',
        })
        expect(views.describe({ kind: 'maps.whole' }).title).toBe('maps.whole')
    })

    it('opens nothing for a stored entry that does not fit its kind', () => {
        const views = favourites()
        // A board needs its concept; the Graph Kanban has none.
        expect(views.describe({ kind: 'kanban.board' }).view).toBeNull()
        expect(views.describe({ kind: 'kanban.whole', concept: 'Garden' }).view).toBeNull()
    })

    it('passes on a change in what the extensions can show', () => {
        const listener = vi.fn()
        let notify = () => {}
        const views = createViewFavourites({
            registry: registryWithBoards(),
            availability: () => ({ state: 'on' }),
            subscribe: (next) => {
                notify = next
                return () => {}
            },
        })
        views.subscribe(listener)
        notify()
        expect(listener).toHaveBeenCalledTimes(1)
    })
})

describe('a PDF as a Favourite', () => {
    it('names itself from what was stored, with the PDF icon, and opens its tab', () => {
        const favourites = createViewFavourites({ registry: createViewRegistry(), availability: () => ({ state: 'missing' }) })
        expect(favourites.describe({ kind: 'asset', concept: 'guide.a1b2c3d4.pdf', name: 'guide.pdf' })).toEqual({
            title: 'guide.pdf',
            icon: 'pdf',
            view: { kind: 'asset', target: 'guide.a1b2c3d4.pdf' },
        })
    })
})
