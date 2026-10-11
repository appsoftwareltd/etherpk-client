import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'

import type { JournalRollControl } from '../view/journal-roll-dom'
import { JOURNAL_SHOW_OLDER_ENTRY, registerJournalCommands } from './journal-commands'

/** The `/` row that loads the next older day of a [[Journal Roll]] (ADR 0136). */

function setup(roll: JournalRollControl | null) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    registerJournalCommands(commands, contributions, { rollOf: () => roll })
    const rows = () =>
        listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).map((item) => item.title)
    return { commands, rows }
}

function control(canLoad: boolean): JournalRollControl {
    return { canLoad: () => canLoad, loadAndFocus: vi.fn(async () => canLoad) }
}

describe('Show older entry', () => {
    it('is offered while the roll has an older day to load', () => {
        expect(setup(control(true)).rows()).toContain('Show older entry')
    })

    it('is not offered at the oldest entry, at the cap, or outside a journal tab', () => {
        expect(setup(control(false)).rows()).not.toContain('Show older entry')
        expect(setup(null).rows()).not.toContain('Show older entry')
    })

    it('loads the next day and focuses its bar', async () => {
        const roll = control(true)
        const { commands } = setup(roll)

        await commands.execute(JOURNAL_SHOW_OLDER_ENTRY)

        expect(roll.loadAndFocus).toHaveBeenCalledOnce()
    })
})
