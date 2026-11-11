import { describe, expect, it } from 'vitest'

import { type CommandMenuContext, type CommandMenuItem, COMMAND_MENU_GROUPS, commandMenuDetail, commandMenuGroup, commandMenuItemsInOrder, listCommandMenuItems, registerCommandMenuItem } from './command-menu'
import { createContributionRegistry } from './contribution-registry'

// A Command Menu row's help text (CONTEXT.md → Command Menu): fixed, or worked out from the editor
// the menu opened in, as `/kanban` says which concept its board is for.

const context: CommandMenuContext = { inTable: false, tableInsertable: true, bodyWritable: true, conceptsAtCaret: ['Garden', 'Kitchen'] }
const row = (detail: CommandMenuItem['detail']): CommandMenuItem => ({ id: 'test.row', title: 'Row', command: 'test.row', detail })

describe('a Command Menu row’s help text', () => {
    it('is the text the row gives', () => {
        expect(commandMenuDetail(row('Insert a table'), context)).toBe('Insert a table')
        expect(commandMenuDetail(row(undefined), context)).toBeUndefined()
    })

    it('is worked out from the menu’s context when the row gives a function', () => {
        expect(commandMenuDetail(row((ctx) => `For ${ctx.conceptsAtCaret?.[0]}`), context)).toBe('For Garden')
    })

    it('is left out when the function throws, so one row never takes the menu down', () => {
        expect(
            commandMenuDetail(
                row(() => {
                    throw new Error('no editor')
                }),
                context,
            ),
        ).toBeUndefined()
    })
})

// An editor that shows one part of a document (the Task Editor's description and comments, ADR 0170)
// offers only the rows that act on the text there: a row that acts on the tab, the document, a View or
// the graph would act on whatever is behind the dialog.
describe('the rows offered in an editor showing part of a document', () => {
    const registry = createContributionRegistry()
    registerCommandMenuItem(registry, { id: 'date.today', title: 'Today', command: 'date.today', actsOnText: true })
    registerCommandMenuItem(registry, { id: 'search.open', title: 'Search', command: 'search.open' })
    registerCommandMenuItem(registry, { id: 'editor.bold', title: 'Bold', command: 'editor.bold', actsOnText: true, when: (ctx) => ctx.bodyWritable })
    const titles = (ctx: CommandMenuContext) => listCommandMenuItems(registry, ctx).map((item) => item.title)

    it('are the rows that say they act on the text', () => {
        expect(titles({ ...context, partOfDocument: true })).toEqual(['Today', 'Bold'])
    })

    it('still answer to their own `when`', () => {
        expect(titles({ ...context, partOfDocument: true, bodyWritable: false })).toEqual(['Today'])
    })

    it('are every row in an editor showing a whole document', () => {
        // In the menu's groups: the two that act on the text are under Insert, Search under Go to.
        expect(titles(context)).toEqual(['Today', 'Bold', 'Search'])
        expect(titles({ ...context, partOfDocument: false })).toEqual(['Today', 'Bold', 'Search'])
    })
})

// The menu lists its rows under three headings, in this order (CONTEXT.md → Command Menu). A row says
// which it belongs under; one that does not, or that names a heading the menu does not have (an
// extension written before the headings), is placed by whether it acts on the text.
describe('the group a Command Menu row is listed under', () => {
    const item = (fields: Partial<CommandMenuItem>): CommandMenuItem => ({ id: 'test.row', title: 'Row', command: 'test.row', ...fields })

    it('is one of Insert, Go to and Settings, in that order', () => {
        expect(COMMAND_MENU_GROUPS).toEqual(['Insert', 'Go to', 'Settings'])
    })

    it('is the group the row names', () => {
        expect(commandMenuGroup(item({ group: 'Insert' }))).toBe('Insert')
        expect(commandMenuGroup(item({ group: 'Go to', actsOnText: true }))).toBe('Go to')
        expect(commandMenuGroup(item({ group: 'Settings' }))).toBe('Settings')
    })

    it('is Insert for a row that names none and acts on the text, and Go to for any other', () => {
        expect(commandMenuGroup(item({ actsOnText: true }))).toBe('Insert')
        expect(commandMenuGroup(item({}))).toBe('Go to')
    })

    it('is worked out the same way for a heading the menu does not have', () => {
        expect(commandMenuGroup(item({ group: 'Tasks' }))).toBe('Go to')
        expect(commandMenuGroup(item({ group: 'Format', actsOnText: true }))).toBe('Insert')
    })

    it('comes before a row’s `order`: rows sort by group, then by `order` within it', () => {
        const registry = createContributionRegistry()
        registerCommandMenuItem(registry, item({ id: 'spelling', group: 'Settings', order: 1 }))
        registerCommandMenuItem(registry, item({ id: 'search', group: 'Go to', order: 5 }))
        registerCommandMenuItem(registry, item({ id: 'map', group: 'Insert', order: 90 }))
        registerCommandMenuItem(registry, item({ id: 'board' }))
        registerCommandMenuItem(registry, item({ id: 'table', group: 'Insert', order: 10 }))
        expect(commandMenuItemsInOrder(registry).map((row) => row.id)).toEqual(['table', 'map', 'search', 'board', 'spelling'])
    })
})
