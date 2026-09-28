import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems, listContextMenuItems } from '$lib/surface'

import { ADD_FRONTMATTER_TO_ACTIVE, DOCUMENT_ADD_FRONTMATTER, registerFrontmatterCommands } from './frontmatter-commands'

type Deps = Parameters<typeof registerFrontmatterCommands>[2]

function setup(overrides: Partial<Deps> = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const deps: Deps = {
        canAddFrontmatter: () => true,
        promptAddFrontmatter: vi.fn(),
        activeConcept: () => 'Kanban',
        onError: vi.fn(),
        ...overrides,
    }
    const dispose = registerFrontmatterCommands(commands, contributions, deps)
    const menuIds = (concept = 'Kanban') => listContextMenuItems(contributions, { kind: 'document-tab', concept, panelId: 'p' }).map((item) => item.id)
    const paletteIds = () => listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).map((item) => item.id)
    return { commands, deps, dispose, menuIds, paletteIds }
}

describe('Add frontmatter', () => {
    it('is a row on a document’s menu that opens the dialog for that document', async () => {
        const { commands, deps, menuIds } = setup()
        expect(menuIds()).toContain(DOCUMENT_ADD_FRONTMATTER)
        await commands.execute(DOCUMENT_ADD_FRONTMATTER, { kind: 'document-tab', concept: 'Bank', panelId: 'p' })
        expect(deps.promptAddFrontmatter).toHaveBeenCalledWith('Bank')
    })

    it('is not offered when the document has nothing left to add', () => {
        const { menuIds, paletteIds } = setup({ canAddFrontmatter: () => false })
        expect(menuIds()).not.toContain(DOCUMENT_ADD_FRONTMATTER)
        expect(paletteIds()).not.toContain(ADD_FRONTMATTER_TO_ACTIVE)
    })

    it('is not offered on a tab that is not a document', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        registerFrontmatterCommands(commands, contributions, { canAddFrontmatter: () => true, promptAddFrontmatter: vi.fn(), activeConcept: () => null })
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'asset' }).map((item) => item.id)).not.toContain(DOCUMENT_ADD_FRONTMATTER)
    })

    it('has a Command Menu row acting on the active document, the keyboard path to it', async () => {
        const { commands, deps, paletteIds } = setup()
        expect(paletteIds()).toContain(ADD_FRONTMATTER_TO_ACTIVE)
        await commands.execute(ADD_FRONTMATTER_TO_ACTIVE)
        expect(deps.promptAddFrontmatter).toHaveBeenCalledWith('Kanban')
    })

    it('offers the Command Menu row only while a document is active', () => {
        const { paletteIds } = setup({ activeConcept: () => null })
        expect(paletteIds()).not.toContain(ADD_FRONTMATTER_TO_ACTIVE)
    })

    it('reports a failure instead of throwing', async () => {
        const { commands, deps } = setup({
            promptAddFrontmatter: () => {
                throw new Error('no store')
            },
        })
        await commands.execute(ADD_FRONTMATTER_TO_ACTIVE)
        expect(deps.onError).toHaveBeenCalledWith('no store')
    })

    it('unregisters everything it added', () => {
        const { dispose, menuIds, paletteIds } = setup()
        dispose()
        expect(menuIds()).not.toContain(DOCUMENT_ADD_FRONTMATTER)
        expect(paletteIds()).not.toContain(ADD_FRONTMATTER_TO_ACTIVE)
    })
})
