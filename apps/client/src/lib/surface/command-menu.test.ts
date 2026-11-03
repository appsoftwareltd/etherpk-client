import { describe, expect, it } from 'vitest'

import { type CommandMenuContext, type CommandMenuItem, commandMenuDetail, listCommandMenuItems, registerCommandMenuItem } from './command-menu'
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
        expect(titles(context)).toEqual(['Today', 'Search', 'Bold'])
        expect(titles({ ...context, partOfDocument: false })).toEqual(['Today', 'Search', 'Bold'])
    })
})
