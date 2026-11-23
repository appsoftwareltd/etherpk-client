import { describe, expect, it } from 'vitest'

import { controlHelp, controlHelpText, createControlHelp, helpForKey } from './control-help'
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

    it('is carried as a tooltip, an aria-description and, when there are chords, aria-keyshortcuts', () => {
        expect(controlHelp("Open today's journal", ['Alt+J'], false)).toEqual({
            'data-tooltip': "Open today's journal (Alt + J)",
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
        expect(helpFor('Open graph search modal', 'search.open')['data-tooltip']).toBe('Open graph search modal (Ctrl + K)')
        table.add({ key: 'Alt+F', command: 'search.open' })
        expect(helpFor('Open graph search modal', 'search.open')['aria-keyshortcuts']).toBe('Control+K Alt+F')
    })

    it('names only the chords the app hears: never Option and a key alone on a Mac', () => {
        const table = createKeybindingTable([{ key: 'Mod+K', command: 'search.open' }, { key: 'Alt+F', command: 'search.open' }, { key: 'Alt+J', command: 'today.open' }])
        const helpFor = createControlHelp(table, true)
        expect(helpFor('Search', 'search.open')['data-tooltip']).toBe('Search (⌘K)')
        expect(helpFor('Today', 'today.open')).toEqual({ 'data-tooltip': 'Today', 'aria-description': 'Today', 'aria-keyshortcuts': undefined })
    })

    it('names no chord where there is no keyboard', () => {
        const table = createKeybindingTable([{ key: 'Mod+K', command: 'search.open' }])
        expect(createControlHelp(table, false, () => false)('Search', 'search.open')['data-tooltip']).toBe('Search')
    })

    it('names the key of a control that runs no Command, where there is a keyboard', () => {
        expect(helpForKey('Undo', 'Mod+Z', false, () => true)).toEqual({ 'data-tooltip': 'Undo (Ctrl + Z)', 'aria-description': 'Undo (Ctrl + Z)', 'aria-keyshortcuts': 'Control+Z' })
        expect(helpForKey('Undo', 'Mod+Z', true, () => true)['data-tooltip']).toBe('Undo (⌘Z)')
        expect(helpForKey('Previous match', 'Shift+Enter', false, () => true)['data-tooltip']).toBe('Previous match (Shift + Enter)')
        expect(helpForKey('Next page', 'PageDown', false, () => true)['data-tooltip']).toBe('Next page (Page Down)')
        expect(helpForKey('Undo', 'Mod+Z', false, () => false)['data-tooltip']).toBe('Undo')
        expect(helpForKey('Next page', null, false, () => true)['data-tooltip']).toBe('Next page')
    })

    it('names no chord without a table', () => {
        expect(createControlHelp(undefined, false)('Open graph search modal', 'search.open')['data-tooltip']).toBe('Open graph search modal')
    })
})
