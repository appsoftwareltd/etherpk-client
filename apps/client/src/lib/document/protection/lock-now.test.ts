import { describe, expect, it } from 'vitest'

import type { LayoutModel, PaneModel, ViewInstance } from '$lib/layout'

import { protectedDocumentPanels } from './lock-now'

function view(kind: string, target: string, extra: Partial<ViewInstance> = {}): ViewInstance {
    return { panelId: extra.panelId ?? `${kind}:${target}`, view: { kind, target }, ...extra }
}

function pane(id: string, ...views: ViewInstance[]): PaneModel {
    return { id, views, activePanelId: views[0]?.panelId ?? null }
}

function model(main: PaneModel[], right: PaneModel[] = []): LayoutModel {
    return {
        regions: {
            'left-sidebar': { panes: [pane('left', view('graph-sidebar', 'root'))], collapsed: false },
            main: { panes: main, collapsed: false },
            'right-sidebar': { panes: right, collapsed: false },
        },
        activePanelId: main[0]?.activePanelId ?? null,
    }
}

const protectedDocs = new Set(['Passwords', 'Medical'])
const isProtected = (target: string) => protectedDocs.has(target)

describe('protectedDocumentPanels', () => {
    it('picks the document Views on protected documents and leaves the rest', () => {
        const m = model([pane('p1', view('document', 'Passwords'), view('document', 'Groceries'), view('document', 'Medical'))])
        expect(protectedDocumentPanels(m, isProtected)).toEqual(['document:Passwords', 'document:Medical'])
    })

    // A privacy act, not a tidy-up: the bulk-close Commands respect a pin, this does not.
    it('includes a pinned tab', () => {
        const m = model([pane('p1', view('document', 'Passwords', { pinned: true }), view('document', 'Groceries'))])
        expect(protectedDocumentPanels(m, isProtected)).toEqual(['document:Passwords'])
    })

    // A copy's panel id is synthetic; the target must come from the instance, not the id.
    it('includes a deliberate second copy, by its own panel id', () => {
        const m = model([
            pane('p1', view('document', 'Passwords')),
            pane('p2', view('document', 'Passwords', { panelId: 'document:Passwords::1' })),
        ])
        expect(protectedDocumentPanels(m, isProtected)).toEqual(['document:Passwords', 'document:Passwords::1'])
    })

    it('reaches every Pane and region', () => {
        const m = model([pane('p1', view('document', 'Groceries'))], [pane('r1', view('document', 'Medical'))])
        expect(protectedDocumentPanels(m, isProtected)).toEqual(['document:Medical'])
    })

    // An asset opened from a protected document is stored by the graph, not inside the fence.
    it('never closes a View of another kind, whatever it shows', () => {
        const m = model([pane('p1', view('asset', 'Passwords'), view('backlinks', 'Medical'))])
        expect(protectedDocumentPanels(m, isProtected)).toEqual([])
    })

    it('is empty when nothing protected is open', () => {
        const m = model([pane('p1', view('document', 'Groceries'))])
        expect(protectedDocumentPanels(m, isProtected)).toEqual([])
    })
})
