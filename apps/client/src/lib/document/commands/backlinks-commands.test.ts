import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'

import { createBacklinksPreferencesStore } from '../backlinks-preferences'
import { BACKLINKS_BELOW_DOCUMENTS, BACKLINKS_GO_TO_BELOW_DOCUMENT, registerBacklinksCommands } from './backlinks-commands'

/**
 * The `/` rows for the backlinks beneath every document (ADR 0135): one row saying which way the
 * collapse setting goes, as spell check's rows do, and **Go to backlinks**.
 */

type Deps = Parameters<typeof registerBacklinksCommands>[2]

function setup(overrides: Partial<Deps> = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const store = createBacklinksPreferencesStore('g1', undefined)
    const deps: Deps = {
        preferences: () => store,
        notify: vi.fn(),
        goToSection: vi.fn(async () => ({ concept: 'Garden', reached: true })),
        ...overrides,
    }
    registerBacklinksCommands(commands, contributions, deps)
    const rows = () =>
        listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).map((item) => item.title)
    return { commands, store, deps, rows }
}

describe('backlinks below documents', () => {
    it('offers the change the row would make: hide while shown, show while hidden', () => {
        const { store, rows } = setup()

        expect(rows()).toContain('Backlinks below documents: hide')
        expect(rows()).not.toContain('Backlinks below documents: show')

        store.set({ collapsedBelowDocuments: true })

        expect(rows()).toContain('Backlinks below documents: show')
        expect(rows()).not.toContain('Backlinks below documents: hide')
    })

    it('sets the one setting every document shares', async () => {
        const { commands, store } = setup()

        await commands.execute(BACKLINKS_BELOW_DOCUMENTS, { collapsed: true })
        expect(store.get().collapsedBelowDocuments).toBe(true)

        await commands.execute(BACKLINKS_BELOW_DOCUMENTS, { collapsed: false })
        expect(store.get().collapsedBelowDocuments).toBe(false)
    })

    it('offers neither row outside a graph', () => {
        const { rows } = setup({ preferences: () => undefined })

        expect(rows().filter((title) => title.startsWith('Backlinks below documents'))).toEqual([])
    })
})

describe('go to backlinks', () => {
    it('is offered in a graph', () => {
        expect(setup().rows()).toContain('Go to backlinks')
    })

    it('brings the section into view and says nothing', async () => {
        const { commands, deps } = setup()

        await commands.execute(BACKLINKS_GO_TO_BELOW_DOCUMENT)

        expect(deps.goToSection).toHaveBeenCalled()
        expect(deps.notify).not.toHaveBeenCalled()
    })

    it('says so when nothing links to the document, and leaves the caret alone', async () => {
        const { commands, deps } = setup({ goToSection: vi.fn(async () => ({ concept: 'Garden', reached: false })) })

        await commands.execute(BACKLINKS_GO_TO_BELOW_DOCUMENT)

        expect(deps.notify).toHaveBeenCalledWith('Nothing links to Garden yet.')
    })

    it('does nothing with no document open', async () => {
        const { commands, deps } = setup({ goToSection: vi.fn(async () => ({ concept: null, reached: false })) })

        await commands.execute(BACKLINKS_GO_TO_BELOW_DOCUMENT)

        expect(deps.notify).not.toHaveBeenCalled()
    })
})
