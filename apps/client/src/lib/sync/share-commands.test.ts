import { describe, expect, it, vi } from 'vitest'

import {
    createCommandRegistry,
    createContributionRegistry,
    listCommandMenuItems,
    listContextMenuItems,
    type ContextMenuTarget,
} from '#lib/surface/index.js'

import { GRAPH_SHARE, registerShareCommands } from './share-commands'

const anywhere = { inTable: false, tableInsertable: false, bodyWritable: false }
const DOCUMENT_TAB: ContextMenuTarget = { kind: 'document-tab', concept: 'Garden', panelId: 'document:Garden' }
const OTHER_TAB: ContextMenuTarget = { kind: 'tab', panelId: 'all-documents:all-documents' }
const FAVOURITE: ContextMenuTarget = { kind: 'favourite', concept: 'Garden' }

function setup(shareable: () => boolean) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const share = vi.fn()
    const teardown = registerShareCommands(commands, contributions, { share, shareable })
    const tabRows = (target: ContextMenuTarget) => listContextMenuItems(contributions, target).map((row) => row.label)
    const menuRows = () => listCommandMenuItems(contributions, anywhere).map((row) => row.title)
    return { commands, share, teardown, tabRows, menuRows }
}

describe('registerShareCommands', () => {
    it('offers Share on every tab and in the Command Menu to somebody who may share the graph', async () => {
        const { commands, share, tabRows, menuRows } = setup(() => true)

        expect(tabRows(DOCUMENT_TAB)).toEqual(['Share this graph…'])
        expect(tabRows(OTHER_TAB)).toEqual(['Share this graph…'])
        expect(menuRows()).toEqual(['Share this graph'])

        await commands.execute(GRAPH_SHARE)
        expect(share).toHaveBeenCalledTimes(1)
    })

    it('leaves Share out, not greyed, for a Local Graph or a Player', async () => {
        const { commands, share, tabRows, menuRows } = setup(() => false)

        expect(tabRows(DOCUMENT_TAB)).toEqual([])
        expect(tabRows(OTHER_TAB)).toEqual([])
        expect(menuRows()).toEqual([])

        // The Command is still there for a caller that reaches it another way, and does nothing.
        await commands.execute(GRAPH_SHARE)
        expect(share).not.toHaveBeenCalled()
    })

    it('follows the answer as it arrives: the role is read after the graph opens', () => {
        let shareable = false
        const { tabRows, menuRows } = setup(() => shareable)
        expect(menuRows()).toEqual([])

        shareable = true
        expect(tabRows(DOCUMENT_TAB)).toEqual(['Share this graph…'])
        expect(menuRows()).toEqual(['Share this graph'])
    })

    it('is a row of a tab only: a Favourite or a Recents row is about its document', () => {
        const { tabRows } = setup(() => true)

        expect(tabRows(FAVOURITE)).toEqual([])
    })

    it('is found by "invite" and "player" as well as "share"', () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        registerShareCommands(commands, contributions, { share: () => {}, shareable: () => true })

        const [row] = listCommandMenuItems(contributions, anywhere)
        expect(row.keywords).toEqual(expect.arrayContaining(['invite', 'player']))
    })

    it('takes its rows and its Command away on teardown', () => {
        const { commands, teardown, menuRows } = setup(() => true)

        teardown()

        expect(menuRows()).toEqual([])
        expect(commands.has(GRAPH_SHARE)).toBe(false)
    })
})
