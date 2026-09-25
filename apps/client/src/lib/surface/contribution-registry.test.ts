import { describe, expect, it } from 'vitest'

import {
    type CommandBarItem,
    COMMAND_BAR_KIND,
    listCommandBarItems,
    registerCommandBarItem,
} from './command-bar'
import {
    type CommandMenuItem,
    COMMAND_MENU_KIND,
    listCommandMenuItems,
    registerCommandMenuItem,
} from './command-menu'
import { createContributionRegistry, isRegisterableContributionId } from './contribution-registry'

describe('contribution registry', () => {
    it('registers and retrieves a value by (kind, id)', () => {
        const reg = createContributionRegistry()
        reg.register('view', 'document', { component: 'DocumentView' })
        expect(reg.has('view', 'document')).toBe(true)
        expect(reg.get('view', 'document')).toEqual({ component: 'DocumentView' })
    })

    it('isolates ids across kinds (same id, different kinds, no collision)', () => {
        const reg = createContributionRegistry()
        reg.register('view', 'today', 1)
        reg.register('command-menu', 'today', 2)
        expect(reg.get('view', 'today')).toBe(1)
        expect(reg.get('command-menu', 'today')).toBe(2)
    })

    it('lists contributions of a kind in registration order', () => {
        const reg = createContributionRegistry()
        reg.register('command-menu', 'b', 'B')
        reg.register('command-menu', 'a', 'A')
        expect(reg.list('command-menu').map((e) => e.id)).toEqual(['b', 'a'])
        expect(reg.list('never-registered')).toEqual([])
    })

    it('throws rather than clobbering a duplicate (kind, id)', () => {
        const reg = createContributionRegistry()
        reg.register('command-menu', 'x', 1)
        expect(() => reg.register('command-menu', 'x', 2)).toThrow(/already registered/)
        expect(reg.get('command-menu', 'x')).toBe(1)
    })

    it('rejects an empty or colon-bearing kind or id', () => {
        const reg = createContributionRegistry()
        expect(() => reg.register('', 'x', 1)).toThrow(/kind/)
        expect(() => reg.register('view', 'a:b', 1)).toThrow(/id/)
        expect(isRegisterableContributionId('a:b')).toBe(false)
        expect(isRegisterableContributionId('acme.flow')).toBe(true)
    })

    it('unregisters via the returned fn and via unregister(), allowing re-registration', () => {
        const reg = createContributionRegistry()
        const off = reg.register('command-menu', 'x', 1)
        off()
        expect(reg.has('command-menu', 'x')).toBe(false)
        expect(() => reg.register('command-menu', 'x', 2)).not.toThrow()
        reg.unregister('command-menu', 'x')
        expect(reg.has('command-menu', 'x')).toBe(false)
    })

    it('the returned unregister fn is a no-op once the id was replaced', () => {
        const reg = createContributionRegistry()
        const off = reg.register('command-menu', 'x', 1)
        reg.unregister('command-menu', 'x')
        reg.register('command-menu', 'x', 2) // a different value now lives at x
        off() // must not remove the newer value
        expect(reg.get('command-menu', 'x')).toBe(2)
    })
})

describe('command-menu helpers', () => {
    const item = (id: string, when?: CommandMenuItem['when']): CommandMenuItem => ({
        id,
        title: id,
        command: `cmd.${id}`,
        when,
    })

    it('registers under the command-menu kind', () => {
        const reg = createContributionRegistry()
        registerCommandMenuItem(reg, item('date.today'))
        expect(reg.has(COMMAND_MENU_KIND, 'date.today')).toBe(true)
    })

    it('lists only items whose when() passes for the context', () => {
        const reg = createContributionRegistry()
        registerCommandMenuItem(reg, item('date.today'))
        registerCommandMenuItem(reg, item('table.addRow', (ctx) => ctx.inTable))
        expect(listCommandMenuItems(reg, { inTable: false, tableInsertable: true, bodyWritable: true }).map((i) => i.id)).toEqual(['date.today'])
        expect(listCommandMenuItems(reg, { inTable: true, tableInsertable: false, bodyWritable: true }).map((i) => i.id)).toEqual([
            'date.today',
            'table.addRow',
        ])
    })
})

describe('command-bar helpers', () => {
    const barItem = (id: string, order?: number, when?: CommandBarItem['when']): CommandBarItem => ({
        id,
        icon: id,
        label: id,
        command: `cmd.${id}`,
        order,
        when,
    })

    it('registers under the command-bar kind', () => {
        const reg = createContributionRegistry()
        registerCommandBarItem(reg, barItem('editor.indent'))
        expect(reg.has(COMMAND_BAR_KIND, 'editor.indent')).toBe(true)
    })

    it('orders by `order`, ties keeping registration order', () => {
        const reg = createContributionRegistry()
        registerCommandBarItem(reg, barItem('b', 20))
        registerCommandBarItem(reg, barItem('a', 10))
        registerCommandBarItem(reg, barItem('c', 20)) // ties with b → after it
        expect(listCommandBarItems(reg).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    })

    it('filters out items whose when() returns false', () => {
        const reg = createContributionRegistry()
        registerCommandBarItem(reg, barItem('always'))
        registerCommandBarItem(reg, barItem('never', 0, () => false))
        expect(listCommandBarItems(reg).map((i) => i.id)).toEqual(['always'])
    })
})
