import { describe, expect, it } from 'vitest'

import type { ConceptCandidate } from './index-db'
import type { RemoteGraphIndex } from './index-worker/client'
import { setActiveGraphIndex } from './backlinks'
import type { LayoutController, LayoutModel, SerializedLayout, ViewRef } from '$lib/layout'
import { setActiveLayoutController } from '$lib/layout'
import { canonicalConceptName, openConcept, openConceptAtLine } from './open-concept'
import { resetReveal, takeReveal } from './reveal'

function stubIndex(candidates: ConceptCandidate[]): RemoteGraphIndex {
    return {
        allConcepts: () => candidates,
    } as unknown as RemoteGraphIndex
}

/** A minimal two-pane model: `panelId` sits in `paneId`'s pane, the other pane is a decoy. */
function twoPaneModel(paneId: string, panelId: string): LayoutModel {
    return {
        activePanelId: 'document:Other',
        regions: {
            main: {
                collapsed: false,
                panes: [
                    {
                        id: paneId,
                        views: [{ panelId, view: { kind: 'document', target: 'Source' } }],
                        activePanelId: panelId,
                    },
                    {
                        id: 'pane-other',
                        views: [{ panelId: 'document:Other', view: { kind: 'document', target: 'Other' } }],
                        activePanelId: 'document:Other',
                    },
                ],
                activePaneId: 'pane-other',
            },
            'left-sidebar': { collapsed: false, panes: [] },
            'right-sidebar': { collapsed: false, panes: [] },
        },
    }
}

function stubController(model: LayoutModel, openView: LayoutController['openView']): LayoutController {
    return {
        openView,
        closeView: () => {},
        closePanel: () => {},
        focusView: () => false,
        isOpen: () => false,
        forgetClosedView: () => {},
        notePanelActivated: () => {},
        activeView: () => null,
        setViewPinned: () => {},
        isViewPinned: () => false,
        toggleSidebar: () => {},
        serialize: (): SerializedLayout => ({ version: 1, model }),
        restore: () => {},
    } as unknown as LayoutController
}

describe('canonicalConceptName', () => {
    it('resolves an alias to the canonical page it names, not the alias itself', () => {
        setActiveGraphIndex(
            stubIndex([
                { display: 'EtherPK', key: 'etherpk', kind: 'page' },
                { display: 'EPK', key: 'epk', kind: 'alias', canonical: 'EtherPK' },
            ]),
        )
        expect(canonicalConceptName('EPK')).toBe('EtherPK')
        setActiveGraphIndex(null)
    })

    it('keeps a page concept exactly as authored', () => {
        setActiveGraphIndex(stubIndex([{ display: 'EtherPK', key: 'etherpk', kind: 'page' }]))
        expect(canonicalConceptName('EtherPK')).toBe('EtherPK')
        setActiveGraphIndex(null)
    })

    it('renames a pageless concept to its majority casing', () => {
        setActiveGraphIndex(
            stubIndex([{ display: 'Kanban', key: 'kanban', kind: 'pageless', references: 12 }]),
        )
        expect(canonicalConceptName('kanban')).toBe('Kanban')
        setActiveGraphIndex(null)
    })

    it('leaves an unknown concept untouched', () => {
        setActiveGraphIndex(stubIndex([]))
        expect(canonicalConceptName('Nothing Here')).toBe('Nothing Here')
        setActiveGraphIndex(null)
    })
})

describe('openConcept', () => {
    it('opens into the source panel\'s own pane, not the region\'s active pane', () => {
        const model = twoPaneModel('pane-source', 'document:Source')
        let opts: Parameters<LayoutController['openView']>[1]
        const controller = stubController(model, (_view, o) => {
            opts = o
            return { panelId: 'document:Target', view: { kind: 'document', target: 'Target' }, region: 'main', focus: () => {}, close: () => {} }
        })
        setActiveLayoutController(controller)

        openConcept('Target', 'document:Source')

        expect(opts?.paneId).toBe('pane-source')
        setActiveLayoutController(null)
    })

    it('falls back to default placement when the source panel is not open', () => {
        const model = twoPaneModel('pane-source', 'document:Source')
        let opts: Parameters<LayoutController['openView']>[1]
        const controller = stubController(model, (_view, o) => {
            opts = o
            return { panelId: 'document:Target', view: { kind: 'document', target: 'Target' }, region: 'main', focus: () => {}, close: () => {} }
        })
        setActiveLayoutController(controller)

        openConcept('Target', 'document:not-open')

        expect(opts?.paneId).toBeUndefined()
        setActiveLayoutController(null)
    })
})

describe('openConceptAtLine', () => {
    it('addresses the reveal to the name the View opens AS, so an alias still lands', () => {
        // The View opens as the canonical page; a reveal addressed to the alias would wait
        // for a View that never mounts.
        setActiveGraphIndex(
            stubIndex([
                { display: 'EtherPK', key: 'etherpk', kind: 'page' },
                { display: 'EPK', key: 'epk', kind: 'alias', canonical: 'EtherPK' },
            ]),
        )
        let opened: ViewRef | undefined
        const controller = stubController(twoPaneModel('pane-source', 'document:Source'), (view) => {
            opened = view
            return { panelId: 'document:EtherPK', view, region: 'main', focus: () => {}, close: () => {} }
        })
        setActiveLayoutController(controller)
        resetReveal()

        openConceptAtLine('EPK', 7)

        expect(opened).toEqual({ kind: 'document', target: 'EtherPK' })
        expect(takeReveal('EtherPK')).toEqual({ target: 'EtherPK', line: 7 })
        setActiveLayoutController(null)
        setActiveGraphIndex(null)
    })

    it('leaves no reveal behind where nothing can open (no layout, as in the /dev harnesses)', () => {
        // A pending reveal with no View to consume it would wait for the concept to be opened
        // by some later, unrelated gesture and land it on a line nobody asked for.
        setActiveLayoutController(null)
        setActiveGraphIndex(null)
        resetReveal()

        expect(() => openConceptAtLine('Anything', 3)).not.toThrow()

        expect(takeReveal('Anything')).toBeNull()
    })
})
