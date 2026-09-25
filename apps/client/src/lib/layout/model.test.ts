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
