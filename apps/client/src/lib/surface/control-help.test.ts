import { describe, expect, it } from 'vitest'

import { controlHelp, controlHelpText, createControlHelp } from './control-help'
import { createKeybindingTable } from './keybindings'

// Help text for a control that runs a Command (ADR 0139): what it does, and the chords bound to
// that Command, read from the keybinding table.

describe('help text', () => {
    it('says what the control does and names its shortcut', () => {
        expect(controlHelpText('Open graph search modal', ['Mod+K'], false)).toBe('Open graph search modal (Ctrl + K)')
        expect(controlHelpText('Open graph search modal', ['Mod+K'], true)).toBe('Open graph search modal (⌘K)')
    })

    it('names every chord bound to the Command, joined by "or"', () => {
        expect(controlHelpText('Open graph search modal', ['Mod+K', 'Alt+F'], false)).toBe('Open graph search modal (Ctrl + K or Alt + F)')
    })

    it('is the description alone when no chord is bound', () => {
        expect(controlHelpText('Open a map of every place and route in this graph', [], false)).toBe('Open a map of every place and route in this graph')
    })

    it('is carried as a title, an aria-description and, when there are chords, aria-keyshortcuts', () => {
        expect(controlHelp("Open today's journal", ['Alt+J'], false)).toEqual({
            title: "Open today's journal (Alt + J)",
            'aria-description': "Open today's journal (Alt + J)",
            'aria-keyshortcuts': 'Alt+J',
        })
        expect(controlHelp('Open a Kanban board of every task in this graph', [], false)['aria-keyshortcuts']).toBeUndefined()
    })
})

describe('help text over the live keybinding table', () => {
    it("reads the Command's chords from the table each time, so a chord bound later shows", () => {
        const table = createKeybindingTable([{ key: 'Mod+K', command: 'search.open' }])
        const helpFor = createControlHelp(table, false)
        expect(helpFor('Open graph search modal', 'search.open').title).toBe('Open graph search modal (Ctrl + K)')
        table.add({ key: 'Alt+F', command: 'search.open' })
        expect(helpFor('Open graph search modal', 'search.open')['aria-keyshortcuts']).toBe('Control+K Alt+F')
    })

    it('names no chord without a table', () => {
        expect(createControlHelp(undefined, false)('Open graph search modal', 'search.open').title).toBe('Open graph search modal')
    })
})
