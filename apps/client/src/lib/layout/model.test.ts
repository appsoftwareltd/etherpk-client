import { describe, expect, it } from 'vitest'

import {
    REGIONS,
    SIDEBAR_REGIONS,
    activatePanel,
    activePaneOf,
    cloneModel,
    createEmptyModel,
    hasCanonical,
    locateCanonical,
    locatePanel,
    pinnedCount,
    removePanel,
    setPinned,
    singletonInstance,
} from './model'
import type { LayoutModel, ViewRef } from './types'
import { viewKey } from './view-ref'

const docA: ViewRef = { kind: 'document', target: 'doc-A' }
const docB: ViewRef = { kind: 'document', target: 'doc-B' }

/** A model with two views (doc-A active) in one `main` pane. */
function twoInMain(): LayoutModel {
    const model = createEmptyModel()
    model.regions.main.panes.push({
        id: 'pane-1',
        views: [singletonInstance(docA), singletonInstance(docB)],
        activePanelId: viewKey(docA),
    })
    model.activePanelId = viewKey(docA)
    return model
}

describe('model helpers', () => {
    it('createEmptyModel has all three regions, empty and not collapsed', () => {
        const model = createEmptyModel()
        expect(Object.keys(model.regions).sort()).toEqual(REGIONS.slice().sort())
        for (const region of REGIONS) {
            expect(model.regions[region].panes).toEqual([])
            expect(model.regions[region].collapsed).toBe(false)
        }
        expect(model.activePanelId).toBeNull()
    })

    it('SIDEBAR_REGIONS are the two sidebars only', () => {
        expect([...SIDEBAR_REGIONS].sort()).toEqual(['left-sidebar', 'right-sidebar'])
    })

    it('singletonInstance keys the panel by its view key', () => {
        expect(singletonInstance(docA)).toEqual({ panelId: 'document:doc-A', view: docA })
    })

    it('locatePanel / locateCanonical / hasCanonical find a view by its key', () => {
        const model = twoInMain()
        expect(locatePanel(model, viewKey(docB))?.region).toBe('main')
        expect(locateCanonical(model, viewKey(docA))?.instance.view).toEqual(docA)
        expect(hasCanonical(model, viewKey(docA))).toBe(true)
        expect(hasCanonical(model, 'document:absent')).toBe(false)
    })

    it('activePaneOf returns the pane holding the active panel', () => {
        const model = twoInMain()
        expect(activePaneOf(model, 'main')?.id).toBe('pane-1')
        expect(activePaneOf(model, 'left-sidebar')).toBeUndefined()
    })

    it('activatePanel sets pane + global active', () => {
        const model = twoInMain()
        activatePanel(model, viewKey(docB))
        expect(model.activePanelId).toBe(viewKey(docB))
        expect(model.regions.main.panes[0].activePanelId).toBe(viewKey(docB))
    })

    it('removePanel drops the view, repoints active, and drops the pane when empty', () => {
        const model = twoInMain()
        expect(removePanel(model, viewKey(docA))).toBe(true)
        // doc-A removed; doc-B becomes the pane's active.
        expect(hasCanonical(model, viewKey(docA))).toBe(false)
        expect(model.regions.main.panes[0].activePanelId).toBe(viewKey(docB))

        expect(removePanel(model, viewKey(docB))).toBe(true)
        // Pane is now empty and removed; the named region itself persists.
        expect(model.regions.main.panes).toEqual([])
        expect(model.activePanelId).toBeNull()
    })

    it('removePanel returns false for an unknown panel', () => {
        expect(removePanel(createEmptyModel(), 'nope:1')).toBe(false)
    })
})

// ADR 0150: closing a Pane's front tab brings forward the tab that was in front before it.
describe('which tab comes forward when the front tab closes', () => {
    const doc = (name: string) => singletonInstance({ kind: 'document', target: name })
    const id = (name: string) => `document:${name}`

    /** One main Pane holding `names` in strip order, with `fronted` brought to the front in turn. */
    function pane(names: string[], fronted: string[]): LayoutModel {
        const model = createEmptyModel()
        model.regions.main.panes.push({ id: 'pane-1', views: names.map(doc), activePanelId: id(names[0]) })
        for (const name of fronted) activatePanel(model, id(name))
        return model
    }
    const front = (model: LayoutModel) => model.regions.main.panes[0]?.activePanelId ?? null

    it('brings forward the tab most recently in front, not the first or the last', () => {
        // Strip: Garden, Kitchen, Shed, Attic. In front in turn: Kitchen, Garden, Shed.
        const model = pane(['Garden', 'Kitchen', 'Shed', 'Attic'], ['Kitchen', 'Garden', 'Shed'])
        removePanel(model, id('Shed'))
        expect(front(model)).toBe(id('Garden'))
        removePanel(model, id('Garden'))
        expect(front(model)).toBe(id('Kitchen'))
    })

    it('falls back to the right-hand neighbour, then the left, for tabs never in front', () => {
        const model = pane(['Garden', 'Kitchen', 'Shed', 'Attic'], ['Kitchen'])
        // Kitchen was the only tab ever in front: its neighbour to the right comes forward.
        removePanel(model, id('Kitchen'))
        expect(front(model)).toBe(id('Shed'))
        // And the last tab's neighbour is on its left.
        const end = pane(['Garden', 'Kitchen', 'Shed'], ['Shed'])
        removePanel(end, id('Shed'))
        expect(front(end)).toBe(id('Kitchen'))
    })

    it('leaves the front alone when a tab behind it closes, and forgets the closed tab', () => {
        const model = pane(['Garden', 'Kitchen', 'Shed'], ['Kitchen', 'Shed'])
        removePanel(model, id('Kitchen'))
        expect(front(model)).toBe(id('Shed'))
        removePanel(model, id('Shed'))
        // Kitchen is gone from the order: Garden, never in front, is all that is left.
        expect(front(model)).toBe(id('Garden'))
    })

    it('moves the keyboard to the tab that came forward in the same Pane when the closed tab had it', () => {
        const model = pane(['Garden', 'Kitchen'], ['Garden', 'Kitchen'])
        model.regions['right-sidebar'].panes.push({ id: 'pane-2', views: [doc('Shed'), doc('Attic')], activePanelId: id('Shed') })
        activatePanel(model, id('Attic'))
        activatePanel(model, id('Shed'))
        removePanel(model, id('Shed'))
        // Not the main region's front tab: the keyboard stays in the Pane it was in.
        expect(model.activePanelId).toBe(id('Attic'))
    })

    it('keeps the keyboard where it was when a tab closes in another Pane', () => {
        const model = pane(['Garden', 'Kitchen'], ['Garden', 'Kitchen'])
        model.regions['right-sidebar'].panes.push({ id: 'pane-2', views: [doc('Shed'), doc('Attic')], activePanelId: id('Shed') })
        activatePanel(model, id('Kitchen'))
        removePanel(model, id('Shed'))
        expect(model.activePanelId).toBe(id('Kitchen'))
        expect(model.regions['right-sidebar'].panes[0].activePanelId).toBe(id('Attic'))
    })
})

describe('model helpers, continued', () => {
    it('cloneModel deep-copies (mutating the clone leaves the original intact)', () => {
        const model = twoInMain()
        const clone = cloneModel(model)
        clone.regions.main.panes[0].views.pop()
        expect(model.regions.main.panes[0].views).toHaveLength(2)
    })
})

const docC: ViewRef = { kind: 'document', target: 'doc-C' }

/** A `main` pane holding three views, doc-A active. */
function threeInMain(): LayoutModel {
    const model = createEmptyModel()
    model.regions.main.panes.push({
        id: 'pane-1',
        views: [singletonInstance(docA), singletonInstance(docB), singletonInstance(docC)],
        activePanelId: viewKey(docA),
    })
    model.activePanelId = viewKey(docA)
    return model
}

const order = (model: LayoutModel) => model.regions.main.panes[0].views.map((v) => v.panelId)

describe('setPinned', () => {
    it('moves a newly pinned view to the front of its Pane', () => {
        const model = threeInMain()
        expect(setPinned(model, viewKey(docC), true)).toBe(0)
        expect(order(model)).toEqual([viewKey(docC), viewKey(docA), viewKey(docB)])
        expect(model.regions.main.panes[0].views[0].pinned).toBe(true)
    })

    it('seats the second pin AFTER the first, so earlier pins keep their place', () => {
        const model = threeInMain()
        setPinned(model, viewKey(docC), true)
        expect(setPinned(model, viewKey(docB), true)).toBe(1)
        expect(order(model)).toEqual([viewKey(docC), viewKey(docB), viewKey(docA)])
    })

    it('drops an unpinned view to the front of what is left, below the pinned block', () => {
        const model = threeInMain()
        setPinned(model, viewKey(docC), true)
        setPinned(model, viewKey(docB), true)
        expect(setPinned(model, viewKey(docC), false)).toBe(1)
        expect(order(model)).toEqual([viewKey(docB), viewKey(docC), viewKey(docA)])
        expect(model.regions.main.panes[0].views[1].pinned).toBeUndefined()
    })

    it('leaves a view already in that state alone', () => {
        const model = threeInMain()
        setPinned(model, viewKey(docA), true)
        expect(setPinned(model, viewKey(docA), true)).toBeNull()
        expect(setPinned(model, viewKey(docB), false)).toBeNull()
        expect(order(model)).toEqual([viewKey(docA), viewKey(docB), viewKey(docC)])
    })

    it('returns null for a panel that is not open', () => {
        expect(setPinned(threeInMain(), 'document:absent', true)).toBeNull()
    })

    it("pinnedCount counts the Pane's pinned block", () => {
        const model = threeInMain()
        expect(pinnedCount(model.regions.main.panes[0])).toBe(0)
        setPinned(model, viewKey(docC), true)
        setPinned(model, viewKey(docB), true)
        expect(pinnedCount(model.regions.main.panes[0])).toBe(2)
    })
})
