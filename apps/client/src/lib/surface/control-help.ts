/**
 * Help text for a control that runs a Command (ADR 0139): what pressing it does, and every chord
 * bound to that Command, "Open graph search modal (Ctrl + K or Alt + F)". The Explorer's
 * buttons and the phone top bar's carry it.
 *
 * The chords are read from the live keybinding table, never written into the text, so a chord an
 * extension binds later, or one that changes, shows without anyone editing the description.
 *
 * A control carries the text three ways: `data-tooltip` for the Client's tooltip (tooltip.ts), which
 * shows on hover, on keyboard focus and for a moment on a tap, `aria-description` for a screen
 * reader, and `aria-keyshortcuts` for the chords as key names.
 */
import { createSubscriber } from 'svelte/reactivity'

import { ariaKeyShortcut, chordsFor, chordWorks, formatChordHint, isApplePlatform, type KeybindingTable } from './keybindings'

/** The attributes a control spreads onto itself. */
export interface ControlHelp {
    'data-tooltip': string
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
        'data-tooltip': text,
        'aria-description': text,
        'aria-keyshortcuts': chords.length > 0 ? chords.map((chord) => ariaKeyShortcut(chord, apple)).join(' ') : undefined,
    }
}

/** A control's name with its shortcut after it, "Search (Ctrl + K)", or the name alone. */
export function withChord(name: string, chord: string | null): string {
    return chord === null ? name : `${name} (${chord})`
}

/**
 * Whether the person has a keyboard to press a chord on, as far as a browser can say: a device whose
 * main pointer hovers. A phone's or a tablet's does not, and naming a shortcut there says nothing.
 */
export function hasKeyboard(): boolean {
    return typeof matchMedia !== 'function' || !matchMedia('(hover: none)').matches
}

/**
 * The help of a control whose key is its own and not a Command's, such as a reader's Undo. `key` is
 * null while the key does nothing.
 */
export function helpForKey(name: string, key: string | null, apple: boolean = isApplePlatform(), keyboard: () => boolean = hasKeyboard): ControlHelp {
    return controlHelp(name, key !== null && keyboard() ? [key] : [], apple)
}

/**
 * `helpFor(description, command)` over `table`, for a component to call from its template: it
 * reads the table's chords for `command` each time, and redraws when the table changes. Without a
 * table (the dev harnesses have none) the text names no chord.
 */
export function createControlHelp(table: KeybindingTable | undefined, apple: boolean = isApplePlatform(), keyboard: () => boolean = hasKeyboard) {
    const watch = createSubscriber((update) => table?.subscribe(update) ?? (() => {}))
    return (description: string, command: string): ControlHelp => {
        watch()
        const chords = table && keyboard() ? chordsFor(table.bindings, command, apple).filter((chord) => chordWorks(chord, apple)) : []
        return controlHelp(description, chords, apple)
    }
}
