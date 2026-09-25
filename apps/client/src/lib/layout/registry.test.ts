import { describe, expect, it } from 'vitest'

import { TAB_TITLE_CHARS, createViewRegistry } from './registry'

// A stand-in component; the registry never renders, it only stores the mapping.
const FakeComponent = (() => {}) as never

describe('view registry', () => {
    it('registers and retrieves an entry by kind', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'document', component: FakeComponent })
        expect(registry.has('document')).toBe(true)
        expect(registry.get('document')?.kind).toBe('document')
    })

    it('reports unknown kinds as absent', () => {
        const registry = createViewRegistry()
        expect(registry.has('asset')).toBe(false)
        expect(registry.get('asset')).toBeUndefined()
        expect(registry.naturalRegion('asset')).toBeUndefined()
    })

    it('exposes the natural region for a kind', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'backlinks', component: FakeComponent, naturalRegion: 'right-sidebar' })
        expect(registry.naturalRegion('backlinks')).toBe('right-sidebar')
    })

    it('titles a view via the entry hook, defaulting to the target', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'document', component: FakeComponent })
        registry.register({
            kind: 'backlinks',
            component: FakeComponent,
            title: (view) => `Backlinks: ${view.target}`,
        })
        expect(registry.title({ kind: 'document', target: 'doc-A' })).toBe('doc-A')
        expect(registry.title({ kind: 'backlinks', target: 'Physics' })).toBe('Backlinks: Physics')
    })

    it('throws rather than silently clobbering a duplicate kind', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'kanban', component: FakeComponent })
        expect(() => registry.register({ kind: 'kanban', component: FakeComponent })).toThrow(
            /already registered/,
        )
        // The first registration is preserved, not overwritten.
        expect(registry.has('kanban')).toBe(true)
    })

    it('rejects an empty or colon-bearing kind (would corrupt the view key)', () => {
        const registry = createViewRegistry()
        expect(() => registry.register({ kind: '', component: FakeComponent })).toThrow(/Invalid view kind/)
        expect(() => registry.register({ kind: 'acme:flow', component: FakeComponent })).toThrow(
            /Invalid view kind/,
        )
    })

    it('accepts a dot-namespaced extension kind', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'acme-diagrams.flow', component: FakeComponent })
        expect(registry.has('acme-diagrams.flow')).toBe(true)
    })

    it('unregisters a kind so it reads as absent and can be re-registered', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'kanban', component: FakeComponent })
        registry.unregister('kanban')
        expect(registry.has('kanban')).toBe(false)
        expect(registry.get('kanban')).toBeUndefined()
        // A now-absent kind can be claimed again without a collision throw.
        expect(() => registry.register({ kind: 'kanban', component: FakeComponent })).not.toThrow()
    })

    it('ignores unregistering an absent kind', () => {
        const registry = createViewRegistry()
        expect(() => registry.unregister('never-registered')).not.toThrow()
    })
})

describe('view registry icons', () => {
    it('exposes the icon a kind registers, and none by default', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'document', component: FakeComponent })
        registry.register({ kind: 'document-tree', component: FakeComponent, icon: 'graph' })
        expect(registry.icon({ kind: 'document', target: 'doc-A' })).toBeUndefined()
        expect(registry.icon({ kind: 'document-tree', target: 'root' })).toBe('graph')
        expect(registry.icon({ kind: 'unknown', target: 'x' })).toBeUndefined()
    })
})

describe('view registry tab title width', () => {
    it('caps every tab title at the same number of characters by default', () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'document', component: FakeComponent })
        expect(TAB_TITLE_CHARS).toBe(30)
        expect(registry.tabTitleChars({ kind: 'document', target: 'doc-A' })).toBe(TAB_TITLE_CHARS)
        // An unregistered kind still gets a tab (the unavailable-View placeholder), so still a cap.
        expect(registry.tabTitleChars({ kind: 'unknown', target: 'x' })).toBe(TAB_TITLE_CHARS)
    })

    it("adds a kind's title prefix, so the subject after it keeps a document title's room", () => {
        const registry = createViewRegistry()
        registry.register({ kind: 'backlinks', component: FakeComponent, titlePrefix: 'Backlinks: ' })
        expect(registry.tabTitleChars({ kind: 'backlinks', target: 'root' })).toBe(TAB_TITLE_CHARS + 11)
    })
})
