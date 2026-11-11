import { describe, expect, it } from 'vitest'

import { COMMAND_MENU_GROUPS, commandMenuGroup, commandMenuItemsInOrder, createCommandRegistry, createContributionRegistry } from '../../surface'
import { registerBacklinksCommands } from './backlinks-commands'
import { registerBookmarkCommands } from './bookmark-commands'
import { registerEditorCommands } from './editor-commands'
import { registerJournalCommands } from './journal-commands'
import { registerFrontmatterCommands } from './frontmatter-commands'
import { registerLinkCommands } from './link-commands'
import { registerProtectionCommands } from './protection-commands'
import { registerQuickNotesCommands } from './quick-notes-commands'
import { registerSpellingCommands } from './spelling-commands'
import { registerAgentInstructionCommands } from './agent-instruction-commands'
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
    registerAgentInstructionCommands(commands, contributions, unused)
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
 * The Command Menu's first-party rows in the order a bare `/` lists them, under its three headings
 * (CONTEXT.md → Command Menu). Each row carries its own `group` and `order`, so this is the one
 * place the whole order is written down: the modules register in the workspace's order
 * (GraphWorkspace.svelte), which is not the menu's. A row whose `when` is false at the caret is
 * left out, and the rest keep this order. An extension's rows fall in among these by their own
 * `group` and `order`, and the extension's tests say where (maps' `Map` between Template and Bold,
 * the Kanban Board's `Open Kanban` after Show older entry).
 *
 * Within Insert the rows reached for most come first: a table, today's date, an image or file, a
 * code block. The rows for the table the caret is in take Table's place there, since Table is not
 * offered inside one.
 */
describe('the Command Menu order', () => {
    const grouped = () => {
        const groups: Record<string, string[]> = {}
        for (const item of firstPartyRows()) (groups[commandMenuGroup(item)] ??= []).push(item.title)
        return groups
    }

    it('lists every first-party row under its heading and in its order, whatever order the modules register in', () => {
        expect(grouped()).toEqual({
            Insert: [
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
                'Today',
                'Upload asset',
                'Code block',
                'Date Picker',
                'Yesterday',
                'Tomorrow',
                'Template',
                'Bold',
                'Italic',
                'Highlight',
                'Copy file path',
                'Copy agent instruction',
                "Move quick notes to today's journal",
                'Add frontmatter',
            ],
            'Go to': ['Search', 'Find and replace', 'Go to backlinks', 'Show older entry', 'Toggle bookmark'],
            Settings: [
                'Lock protected documents',
                'Unlock protected documents',
                'Protect this document',
                'Remove protection from this document',
                'Backlinks below documents: hide',
                'Backlinks below documents: show',
                'Spell check: turn off',
                'Spell check: turn on',
                'Spelling languages',
                'Reset workspace',
            ],
        })
    })

    it('lists the groups in the order Insert, Go to, Settings', () => {
        const groups = firstPartyRows().map((item) => commandMenuGroup(item))
        expect(groups.filter((group, i) => group !== groups[i - 1])).toEqual([...COMMAND_MENU_GROUPS])
    })

    // A heading the menu does not have would be placed by the fallback, and a typo would pass unseen.
    it('names one of the menu’s headings on every first-party row', () => {
        expect(firstPartyRows().filter((item) => !COMMAND_MENU_GROUPS.some((group) => group === item.group)).map((item) => item.title)).toEqual([])
    })

    // The Task Editor's description and comments (ADR 0170) offer only the rows that act on the text:
    // inserting, formatting, editing a table, and copying what the caret's line holds. The others act
    // on the tab, the document as a whole, a View, the graph or a setting, which from inside the
    // dialog would be whatever is behind it.
    it('offers these rows in an editor showing part of a document', () => {
        expect(firstPartyRows().filter((item) => item.actsOnText).map((item) => item.title)).toEqual([
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
            'Today',
            'Upload asset',
            'Code block',
            'Date Picker',
            'Yesterday',
            'Tomorrow',
            'Template',
            'Bold',
            'Italic',
            'Highlight',
            'Copy file path',
            'Copy agent instruction',
        ])
        // Every one of them is under Insert: the heading is the only one such an editor shows.
        expect(new Set(firstPartyRows().filter((item) => item.actsOnText).map((item) => commandMenuGroup(item)))).toEqual(new Set(['Insert']))
    })
})
