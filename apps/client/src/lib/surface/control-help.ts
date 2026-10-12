/**
 * Help text for a control that runs a Command (ADR 0139): what pressing it does, and every chord
 * bound to that Command, "Open graph search modal (Ctrl + K or Alt + F)". The Graph Sidebar's
 * buttons and the phone top bar's carry it.
 *
 * The chords are read from the live keybinding table, never written into the text, so a chord an
 * extension binds later, or one that changes, shows without anyone editing the description.
 *
 * A control carries the text three ways, as the rest of the app does: a native `title` for the
 * mouse, `aria-description` for a screen reader, and `aria-keyshortcuts` for the chords as key
 * names. A `title` does not show on keyboard focus or on touch.
 */
import { createSubscriber } from 'svelte/reactivity'

import { ariaKeyShortcut, chordsFor, formatChordHint, isApplePlatform, type KeybindingTable } from './keybindings'

/** The attributes a control spreads onto itself. */
export interface ControlHelp {
    title: string
    'aria-description': string
    'aria-keyshortcuts': string | undefined
}

/** The help text: the description, then the chords in brackets, joined by "or". */
export function controlHelpText(description: string, chords: readonly string[], apple: boolean): string {
    if (chords.length === 0) return description
    return `${description} (${chords.map((chord) => formatChordHint(chord, apple)).join(' or ')})`
}

/** The help text as the attributes a control carries. */
export function controlHelp(description: string, chords: readonly string[], apple: boolean): ControlHelp {
    const text = controlHelpText(description, chords, apple)
    return {
        title: text,
        'aria-description': text,
        'aria-keyshortcuts': chords.length > 0 ? chords.map((chord) => ariaKeyShortcut(chord, apple)).join(' ') : undefined,
    }
}

/**
 * `helpFor(description, command)` over `table`, for a component to call from its template: it
 * reads the table's chords for `command` each time, and redraws when the table changes. Without a
 * table (the dev harnesses have none) the text names no chord.
 */
export function createControlHelp(table: KeybindingTable | undefined, apple: boolean = isApplePlatform()) {
    const watch = createSubscriber((update) => table?.subscribe(update) ?? (() => {}))
    return (description: string, command: string): ControlHelp => {
        watch()
        return controlHelp(description, table ? chordsFor(table.bindings, command) : [], apple)
    }
}
