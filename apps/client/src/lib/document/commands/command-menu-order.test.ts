import { describe, expect, it } from 'vitest'

import { commandMenuItemsInOrder, createCommandRegistry, createContributionRegistry } from '../../surface'
import { registerKanbanCommands } from '../../kanban/kanban-commands'
import { registerEditorCommands } from './editor-commands'
import { registerFrontmatterCommands } from './frontmatter-commands'
import { registerLinkCommands } from './link-commands'
import { registerProtectionCommands } from './protection-commands'
import { registerQuickNotesCommands } from './quick-notes-commands'
import { registerSpellingCommands } from './spelling-commands'
import { registerTaskReferenceCommands } from './task-reference-commands'

/** Dependencies no registration reads: only the rows' `when` and the Commands call them. */
const unused = {} as never

/**
 * The Command Menu's first-party rows in the order a bare `/` lists them (CONTEXT.md → Command
 * Menu). Each row carries its own `order`, so this is the one place the whole order is written down:
 * the modules register in the workspace's order (GraphWorkspace.svelte), which is not the menu's.
 * A row whose `when` is false at the caret is left out, and the rest keep this order.
 */
describe('the Command Menu order', () => {
    it('lists every first-party row in its order, whatever order the modules register in', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        registerSpellingCommands(commands, contributions)
        registerEditorCommands(commands, contributions)
        registerLinkCommands(commands, contributions)
        registerKanbanCommands(commands, contributions, unused)
        registerTaskReferenceCommands(commands, contributions, unused)
        registerQuickNotesCommands(commands, contributions, unused)
        registerProtectionCommands(commands, contributions, unused)
        registerFrontmatterCommands(commands, contributions, unused)

        expect(commandMenuItemsInOrder(contributions).map((item) => item.title)).toEqual([
            'Search',
            'Today',
            'Upload asset',
            'Date Picker',
            'Lock protected documents',
            'Unlock protected documents',
            'Protect this document',
            'Remove protection from this document',
            'Bold',
            'Italic',
            'Highlight',
            'Code block',
            'Table',
            'Table: Add column',
            'Table: Add row',
            'Table: Format',
            'Table: Remove row',
            'Table: Remove column',
            'Table: Remove rows above',
            'Table: Remove rows below',
            'Table: Remove columns right',
            'Table: Remove columns left',
            'Copy file path',
            'Kanban board',
            'Copy task reference',
            "Move quick notes to today's journal",
            'Add frontmatter',
            'Spell check: turn off',
            'Spell check: turn on',
            'Spelling languages',
            'Reset workspace',
        ])
    })
})
