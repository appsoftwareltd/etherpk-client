import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems, listContextMenuItems } from '#lib/surface/index.js'

import { PAGE_COPY_LINK, PAGE_GO_TO_ADDRESS, registerPageAddressCommands } from './page-address-commands'

/** The Command Menu's context on a page with nothing about the caret to say. */
const ANYWHERE = { inTable: false, tableInsertable: false, bodyWritable: true }

function setup() {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const deps = { copyLink: vi.fn(async () => {}), goToAddress: vi.fn() }
    const detach = registerPageAddressCommands(commands, contributions, deps)
    return { commands, contributions, deps, detach }
}

describe('the page address’s Commands', () => {
    it('are in the Command Menu with the ways to go somewhere', () => {
        const { contributions } = setup()
        const rows = listCommandMenuItems(contributions, ANYWHERE).map((item) => [item.title, item.group])
        expect(rows).toEqual([
            ['Copy link to page', 'Go to'],
            ['Go to address…', 'Go to'],
        ])
    })

    it('offer Go to address… in the Activity Bar’s menu, which a phone has, and nowhere else', () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'activity-bar' }).map((row) => [row.label, row.icon])).toEqual([['Go to address…', 'globe']])
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'p' })).toEqual([])
    })

    it('run what the workspace does for each', async () => {
        const { commands, deps } = setup()
        await commands.execute(PAGE_COPY_LINK)
        await commands.execute(PAGE_GO_TO_ADDRESS)
        expect(deps.copyLink).toHaveBeenCalledOnce()
        expect(deps.goToAddress).toHaveBeenCalledOnce()
    })

    it('are gone once the workspace closes', () => {
        const { commands, contributions, detach } = setup()
        detach()
        expect(commands.has(PAGE_COPY_LINK) || commands.has(PAGE_GO_TO_ADDRESS)).toBe(false)
        expect(listCommandMenuItems(contributions, ANYWHERE)).toEqual([])
        expect(listContextMenuItems(contributions, { kind: 'activity-bar' })).toEqual([])
    })
})
