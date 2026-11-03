import { describe, expect, it } from 'vitest'

import { commandMenuItemsInOrder, createCommandRegistry, createContributionRegistry } from '../../surface'
import { registerBacklinksCommands } from './backlinks-commands'
import { registerBookmarkCommands } from './bookmark-commands'
import { registerEditorCommands } from './editor-commands'
import { registerJournalCommands } from './journal-commands'
import { registerFrontmatterCommands } from './frontmatter-commands'
import { registerLinkCommands } from './link-commands'
import { registerProtectionCommands } from './protection-commands'
import { registerQuickNotesCommands } from './quick-notes-commands'
import { registerSpellingCommands } from './spelling-commands'
import { registerTaskReferenceCommands } from './task-reference-commands'
import { registerTemplateCommands } from './template-commands'

/** Dependencies no registration reads: only the rows' `when` and the Commands call them. */
const unused = {} as never

/** Every first-party row, registered in an order that is not the menu's. */
function firstPartyRows() {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    registerSpellingCommands(commands, contributions)
    registerEditorCommands(commands, contributions)
    registerLinkCommands(commands, contributions)
    registerTaskReferenceCommands(commands, contributions, unused)
    registerQuickNotesCommands(commands, contributions, unused)
    registerProtectionCommands(commands, contributions, unused)
    registerFrontmatterCommands(commands, contributions, unused)
    registerBacklinksCommands(commands, contributions, unused)
    registerJournalCommands(commands, contributions)
    registerTemplateCommands(commands, contributions, unused)
    registerBookmarkCommands(commands, contributions, unused)
    return commandMenuItemsInOrder(contributions)
}

/**
 * The Command Menu's first-party rows in the order a bare `/` lists them (CONTEXT.md → Command
 * Menu). Each row carries its own `order`, so this is the one place the whole order is written down:
 * the modules register in the workspace's order (GraphWorkspace.svelte), which is not the menu's.
 * A row whose `when` is false at the caret is left out, and the rest keep this order. An
 * extension's rows fall in among these by their own `order`, and the extension's tests say where
 * (the Kanban Board's `Open Kanban` between Copy file path and Copy task reference, maps' `Map`
 * straight after Table).
 */
describe('the Command Menu order', () => {
    it('lists every first-party row in its order, whatever order the modules register in', () => {
        expect(firstPartyRows().map((item) => item.title)).toEqual([
            'Search',
            'Find and replace',
            'Go to backlinks',
            'Show older entry',
            'Today',
            'Yesterday',
            'Tomorrow',
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
            'Template',
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
            'Copy task reference',
            'Toggle bookmark',
            "Move quick notes to today's journal",
            'Add frontmatter',
            'Backlinks below documents: hide',
            'Backlinks below documents: show',
            'Spell check: turn off',
            'Spell check: turn on',
            'Spelling languages',
            'Reset workspace',
        ])
    })

    // The Task Editor's description and comments (ADR 0170) offer only the rows that act on the text:
    // inserting, formatting, editing a table, and copying what the caret's line holds. The others act
    // on the tab, the document as a whole, a View, the graph or a setting, which from inside the
    // dialog would be whatever is behind it.
    it('offers these rows in an editor showing part of a document', () => {
        expect(firstPartyRows().filter((item) => item.actsOnText).map((item) => item.title)).toEqual([
            'Today',
            'Yesterday',
            'Tomorrow',
            'Upload asset',
            'Date Picker',
            'Bold',
            'Italic',
            'Highlight',
            'Code block',
            'Template',
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
            'Copy task reference',
        ])
    })
})
