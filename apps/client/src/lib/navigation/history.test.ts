import { describe, expect, it } from 'vitest'

import { createLayoutController } from '$lib/layout/controller'
import { createStubRenderer } from '$lib/layout/testing/stub-renderer'
import type { LayoutController } from '$lib/layout/types'

import { createHistoryEngine, type HistoryEngine, type VisitState } from './history'
import type { ViewPosition } from './position'

interface Harness {
    controller: LayoutController
    engine: HistoryEngine
    pushed: { url: string; state: VisitState }[]
    replaced: { url: string; state: VisitState }[]
    positions: Map<string, ViewPosition> // live "editor" positions by viewKey
    reading: Map<string, ViewPosition>
    snapshots: Map<number, ViewPosition>
    restored: { viewKey: string; position: ViewPosition }[]
}

function makeHarness(): Harness {
    const pushed: Harness['pushed'] = []
    const replaced: Harness['replaced'] = []
    const positions = new Map<string, ViewPosition>()
    const reading = new Map<string, ViewPosition>()
    const snapshots = new Map<number, ViewPosition>()
    const restored: Harness['restored'] = []
    const controller = createLayoutController({
        renderer: createStubRenderer(),
        onChange: () => engine.sync(),
    })
    const engine = createHistoryEngine({
        graphId: 'g1',
        controller: () => controller,
        pushUrl: (url, state) => pushed.push({ url, state }),
        replaceUrl: (url, state) => replaced.push({ url, state }),
        capture: (viewKey) => positions.get(viewKey) ?? null,
        restore: (viewKey, position) => void restored.push({ viewKey, position }),
        readingPosition: (viewKey) => reading.get(viewKey) ?? null,
        saveSnapshot: (id, position) => void (position && snapshots.set(id, position)),
        loadSnapshot: (id) => snapshots.get(id) ?? null,
    })
    controller.restore(null) // default layout; onChange not fired during restore
    return { controller, engine, pushed, replaced, positions, reading, snapshots, restored }
}

describe('seed', () => {
    it('replaces (never pushes) the URL of the restored active document', () => {
        const h = makeHarness()
        h.engine.seed()
        expect(h.pushed).toHaveLength(0)
        expect(h.replaced).toHaveLength(1)
        expect(h.replaced[0].url).toBe('/g/g1/d/today')
        expect(h.replaced[0].state.panelId).toBe('document:today')
    })
})

describe('sync', () => {
    it('pushes a Visit when a document opens in main', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        expect(h.pushed).toHaveLength(1)
        expect(h.pushed[0].url).toBe('/g/g1/d/Alpha')
        expect(h.pushed[0].state.panelId).toBe('document:Alpha')
        expect(h.pushed[0].state.paneId).toBeTruthy()
    })

    it('pushes when switching back to an already-open tab', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        h.controller.focusView({ kind: 'document', target: 'today' })
        expect(h.pushed).toHaveLength(2)
        expect(h.pushed[1].url).toBe('/g/g1/d/today')
    })

    it('is idempotent for the already-current panel', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        h.controller.focusView({ kind: 'document', target: 'Alpha' })
        expect(h.pushed).toHaveLength(1)
    })

    it('pushes a Visit for the document a close reveals (the close itself is not one)', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        expect(h.pushed).toHaveLength(1)
        // Closing active Alpha reveals the journal: ONE push, for the journal.
        h.controller.closeView({ kind: 'document', target: 'Alpha' })
        expect(h.pushed).toHaveLength(2)
        expect(h.pushed[1].state.panelId).toBe('document:today')
    })

    it('ignores sidebar focus entirely', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.focusView({ kind: 'document-tree', target: 'root' })
        expect(h.pushed).toHaveLength(0)
        // and switching back to the SAME document pushes nothing either
        h.controller.focusView({ kind: 'document', target: 'today' })
        expect(h.pushed).toHaveLength(0)
    })

    it('snapshots the Visit being left at the moment of leaving', () => {
        const h = makeHarness()
        h.engine.seed()
        h.positions.set('document:today', { scrollTop: 500, anchor: 3, head: 3 })
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        const seededId = h.replaced[0].state.id
        expect(h.snapshots.get(seededId)).toEqual({ scrollTop: 500, anchor: 3, head: 3 })
    })
})

describe('apply (browser Back/Forward)', () => {
    it('focuses a still-open target and restores its per-Visit snapshot', () => {
        const h = makeHarness()
        h.engine.seed()
        h.positions.set('document:today', { scrollTop: 500, anchor: 3, head: 3 })
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        const back = h.replaced[0].state // the seeded journal Visit
        h.engine.apply(back)
        expect(h.controller.activeView()?.panelId).toBe('document:today')
        expect(h.restored.at(-1)).toEqual({
            viewKey: 'document:today',
            position: { scrollTop: 500, anchor: 3, head: 3 },
        })
        // applying did not push a new Visit
        expect(h.pushed).toHaveLength(1)
    })

    it('reopens a closed target in its original pane', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        const alphaVisit = h.pushed[0].state
        h.controller.closeView({ kind: 'document', target: 'Alpha' })
        h.engine.apply(alphaVisit)
        expect(h.controller.isOpen({ kind: 'document', target: 'Alpha' })).toBe(true)
        expect(h.controller.activeView()?.panelId).toBe('document:Alpha')
        expect(h.controller.activeView()?.paneId).toBe(alphaVisit.paneId)
    })

    it('falls back to the Reading Position when no snapshot exists', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        h.reading.set('document:today', { scrollTop: 42, anchor: 1, head: 1 })
        const back: VisitState = { id: 424242, panelId: 'document:today' } // unknown id → no snapshot
        h.engine.apply(back)
        expect(h.restored.at(-1)?.position.scrollTop).toBe(42)
    })

    it('snapshots the Visit being left on pop too, and is idempotent per id', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'document', target: 'Alpha' })
        const alphaId = h.pushed[0].state.id
        h.positions.set('document:Alpha', { scrollTop: 77, anchor: 0, head: 0 })
        h.engine.apply(h.replaced[0].state) // back to journal
        expect(h.snapshots.get(alphaId)?.scrollTop).toBe(77)
        const count = h.pushed.length
        h.engine.apply(h.replaced[0].state) // same id again (e.g. page.state effect re-run)
        expect(h.pushed).toHaveLength(count)
    })
})

describe('visitFromUrl (real navigation: deep link after load / post-reload pop)', () => {
    it('opens the concept without pushing and restores its Reading Position', () => {
        const h = makeHarness()
        h.engine.seed()
        h.reading.set('document:Beta', { scrollTop: 9, anchor: 4, head: 4 })
        h.engine.visitFromUrl({ kind: 'document', target: 'Beta' })
        expect(h.pushed).toHaveLength(0)
        expect(h.controller.activeView()?.panelId).toBe('document:Beta')
        expect(h.restored.at(-1)?.position.scrollTop).toBe(9)
    })
})

describe('an Asset tab is a Visit too', () => {
    // Before assets were addressable, opening one changed no URL and pushed no entry, so Back
    // walked straight past it to whatever document had been active before.
    const asset = { kind: 'asset' as const, target: 'chart.a1b2c3d4.png' }

    it('pushes an entry with the asset URL when an asset tab becomes active', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView(asset)
        h.engine.sync()

        expect(h.pushed.at(-1)?.url).toBe('/g/g1/a/chart.a1b2c3d4.png')
        expect(h.pushed.at(-1)?.state.panelId).toBe('asset:chart.a1b2c3d4.png')
    })

    it('Back reopens the asset tab, as it does a document', () => {
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView(asset)
        h.engine.sync()
        const assetVisit = h.pushed.at(-1)!.state
        h.controller.closeView(asset)

        h.engine.apply(assetVisit)

        expect(h.controller.activeView()?.view).toEqual(asset)
    })

    it('a deep link to an asset URL opens it without pushing', () => {
        const h = makeHarness()
        h.engine.seed()

        h.engine.visitFromUrl(asset)

        expect(h.pushed).toHaveLength(0)
        expect(h.controller.activeView()?.panelId).toBe('asset:chart.a1b2c3d4.png')
    })

    it('a Theme in its editor is a Visit as well: its URL is pushed when the View becomes active', () => {
        // The Theme editor was the second main-region View to grow an address (ADR 0023,
        // 2026-09-20): Settings sends people to it, and Back from it has to find Settings.
        const h = makeHarness()
        h.engine.seed()
        h.controller.openView({ kind: 'theme', target: 'docs-theme' })
        h.engine.sync()

        expect(h.pushed.at(-1)?.url).toBe('/g/g1/t/docs-theme')
        expect(h.pushed.at(-1)?.state.panelId).toBe('theme:docs-theme')
    })

    it('still pushes nothing for a View that has no address', () => {
        const h = makeHarness()
        h.engine.seed()
        const before = h.pushed.length
        h.controller.openView({ kind: 'backlinks', target: 'Physics' }, { region: 'main' })
        h.engine.sync()

        expect(h.pushed).toHaveLength(before)
    })
})
