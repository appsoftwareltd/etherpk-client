import { describe, expect, it } from 'vitest'

import { createContributionRegistry } from './contribution-registry'
import { isDocumentTarget, listContextMenuItems, registerContextMenuItem, type ContextMenuTarget } from './context-menu'

const tab = (concept: string): ContextMenuTarget => ({ kind: 'document-tab', concept })

describe('context-menu contribution point', () => {
    it('lists applicable rows in order', () => {
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, { id: 'b', label: 'B', command: 'b', order: 20 })
        registerContextMenuItem(registry, { id: 'a', label: 'A', command: 'a', order: 10 })

        expect(listContextMenuItems(registry, tab('Physics')).map((r) => r.label)).toEqual(['A', 'B'])
    })

    it('filters by target, so add/remove are exact complements', () => {
        // One favourited document must never show both "Add to favourites" and "Remove".
        const registry = createContributionRegistry()
        const favourited = new Set(['physics'])
        registerContextMenuItem(registry, {
            id: 'add',
            label: 'Add to favourites',
            command: 'favourites.add',
            when: (t) => isDocumentTarget(t) && !favourited.has(t.concept.toLowerCase()),
        })
        registerContextMenuItem(registry, {
            id: 'remove',
            label: 'Remove from favourites',
            command: 'favourites.remove',
            when: (t) => isDocumentTarget(t) && favourited.has(t.concept.toLowerCase()),
        })

        expect(listContextMenuItems(registry, tab('Physics')).map((r) => r.label)).toEqual(['Remove from favourites'])
        expect(listContextMenuItems(registry, tab('Recipes')).map((r) => r.label)).toEqual(['Add to favourites'])
    })

    it('carries a row’s icon through, and none for a row without one', () => {
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, { id: 'k', label: 'Open Kanban board', command: 'kanban.open', icon: 'kanban', order: 1 })
        registerContextMenuItem(registry, { id: 'r', label: 'Rename…', command: 'document.rename', order: 2 })

        const [kanban, rename] = listContextMenuItems(registry, tab('Physics'))
        expect(kanban.icon).toBe('kanban')
        expect(rename.icon).toBeUndefined()
    })

    it('resolves a function label against the target', () => {
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, { id: 'r', label: (t) => `Rename "${isDocumentTarget(t) ? t.concept : ""}"`, command: 'document.rename' })
        expect(listContextMenuItems(registry, tab('Physics'))[0].label).toBe('Rename "Physics"')
    })

    it('can apply to some surfaces and not others', () => {
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, {
            id: 'unfav',
            label: 'Remove from favourites',
            command: 'favourites.remove',
            when: (t) => t.kind === 'favourite',
        })
        expect(listContextMenuItems(registry, { kind: 'favourite', concept: 'Physics' })).toHaveLength(1)
        expect(listContextMenuItems(registry, tab('Physics'))).toHaveLength(0)
    })

    it('carries separatorBefore through for grouping', () => {
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, { id: 'a', label: 'A', command: 'a', order: 1 })
        registerContextMenuItem(registry, { id: 'b', label: 'B', command: 'b', order: 2, separatorBefore: true })
        expect(listContextMenuItems(registry, tab('X')).map((r) => r.separatorBefore)).toEqual([false, true])
    })

    it('lets a row decide its separator from the target, when which row heads its group varies', () => {
        // A Kanban card's "Move to" rows leave out the card's own lane, so the row that heads the
        // group, and carries its separator, depends on where the card is.
        const registry = createContributionRegistry()
        registerContextMenuItem(registry, { id: 'open', label: 'Open', command: 'open', order: 1 })
        registerContextMenuItem(registry, {
            id: 'first',
            label: 'First',
            command: 'first',
            order: 2,
            when: (t) => t.kind !== 'tab',
            separatorBefore: true,
        })
        registerContextMenuItem(registry, {
            id: 'second',
            label: 'Second',
            command: 'second',
            order: 3,
            separatorBefore: (t) => t.kind === 'tab',
        })
        expect(listContextMenuItems(registry, tab('X')).map((r) => r.separatorBefore)).toEqual([false, true, false])
        expect(listContextMenuItems(registry, { kind: 'tab', panelId: 'p' }).map((r) => r.separatorBefore)).toEqual([false, true])
    })

    it('takes only the document kinds for a document, never a kind added later', () => {
        // The guard listed the kinds that are NOT documents, so a new kind (a Kanban card)
        // passed as a document and the Favourites rows read a concept it does not have.
        for (const kind of ['document-tab', 'favourite', 'recent', 'document-row'] as const) {
            expect(isDocumentTarget({ kind, concept: 'Physics' })).toBe(true)
        }
        expect(
            isDocumentTarget({ kind: 'kanban-card', board: 'b', card: 'Acme:0', label: 'x', status: 'open', priority: null }),
        ).toBe(false)
        expect(isDocumentTarget({ kind: 'tab', panelId: 'p' })).toBe(false)
    })

    it('unregisters', () => {
        const registry = createContributionRegistry()
        const dispose = registerContextMenuItem(registry, { id: 'a', label: 'A', command: 'a' })
        expect(listContextMenuItems(registry, tab('X'))).toHaveLength(1)
        dispose()
        expect(listContextMenuItems(registry, tab('X'))).toHaveLength(0)
    })
})
