import { describe, expect, it } from 'vitest'

import { type CommandMenuContext, type CommandMenuItem, commandMenuDetail } from './command-menu'

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
