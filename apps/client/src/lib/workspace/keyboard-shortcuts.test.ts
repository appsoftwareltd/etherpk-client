import { describe, expect, it } from 'vitest'

import { eventMatches, parseChord } from '$lib/surface'

import { APP_KEYBINDINGS, EDITOR_SHORTCUTS } from './keyboard-shortcuts'

// The list is both the binding and the card, so its shape is worth pinning: a chord that
// dispatches to two commands would fire the first and silently hide the second, and a row with
// no label would show as a blank line in the dialog.
describe('APP_KEYBINDINGS', () => {
    it('binds each chord to exactly one command', () => {
        const chords = APP_KEYBINDINGS.map((b) => b.key.toLowerCase())
        expect(new Set(chords).size).toBe(chords.length)
    })

    it('labels every row and parses every chord to a main key', () => {
        for (const binding of APP_KEYBINDINGS) {
            expect(binding.label.length, binding.key).toBeGreaterThan(0)
            expect(parseChord(binding.key).key, binding.key).not.toBe('')
        }
    })

    it("opens today's journal on Alt+J", () => {
        const journal = APP_KEYBINDINGS.filter((b) => b.command === 'document.openTodayJournal')
        expect(journal.map((b) => b.key)).toEqual(['Alt+J'])
        expect(
            eventMatches(journal[0].key, { key: 'j', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }),
        ).toBe(true)
    })

    it('reaches the Publish tab on Alt+P and publishes again on Alt+Shift+P', () => {
        // The pair a writer wants after an edit: open the publication's settings, or run the
        // last publish again without opening anything (2026-09-19).
        const keyFor = (command: string) => APP_KEYBINDINGS.filter((b) => b.command === command).map((b) => b.key)
        expect(keyFor('publish.settings')).toEqual(['Alt+P'])
        expect(keyFor('publish.run')).toEqual(['Alt+Shift+P'])
        expect(APP_KEYBINDINGS.filter((b) => b.group === 'Publish').map((b) => b.command)).toEqual(['publish.settings', 'publish.run'])
        expect(
            eventMatches('Alt+Shift+P', { key: 'P', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }),
        ).toBe(true)
    })

    it('gives each Sidebar a toggle letter and each resident a reveal letter', () => {
        const keyFor = (command: string) => APP_KEYBINDINGS.filter((b) => b.command === command).map((b) => b.key)
        expect(keyFor('layout.toggleSidebar')).toEqual(['Alt+L'])
        expect(keyFor('layout.toggleBacklinks')).toEqual(['Alt+R'])
        expect(keyFor('graph.open')).toEqual(['Alt+G'])
        expect(keyFor('quickNotes.open')).toEqual(['Alt+N'])
        expect(keyFor('backlinks.open')).toEqual(['Alt+B'])
        expect(keyFor('tasks.open')).toEqual(['Alt+T'])
    })

    it('toggles spell check on Alt+S, listed under Editor', () => {
        const spell = APP_KEYBINDINGS.filter((b) => b.key === 'Alt+S')
        expect(spell.map((b) => [b.command, b.group])).toEqual([['editor.toggleSpellCheck', 'Editor']])
    })

    it('has a chord that opens the card itself', () => {
        expect(APP_KEYBINDINGS.some((b) => b.command === 'help.openShortcuts')).toBe(true)
    })
})

describe('EDITOR_SHORTCUTS', () => {
    it('labels every row in every group', () => {
        for (const group of EDITOR_SHORTCUTS) {
            expect(group.shortcuts.length, group.title).toBeGreaterThan(0)
            for (const s of group.shortcuts) expect(s.label.length, `${group.title}: ${s.key}`).toBeGreaterThan(0)
        }
    })
})
