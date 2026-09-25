/**
 * The app-level keyboard-shortcut layer: keys → command ids (Dual Mode Editor.md →
 * Keyboard scheme). The Command registry's genuine first *indirect* consumer. These
 * are *app-level* chords (open journal, toggle backlinks/sidebar); editor block-ops
 * stay CM-native and never come through here.
 *
 * The chord matcher is pure (node-testable); `attachKeybindings` is the thin window
 * adapter.
 */

import type { CommandRegistry } from './command-registry'

export interface Keybinding {
    /** Chord like `Alt+J`, `Mod+Shift+K`. Modifiers: Mod (Ctrl/⌘), Ctrl, Alt, Shift. */
    key: string
    command: string
    arg?: unknown
}

/** The shape of a keyboard event the matcher needs (a real KeyboardEvent satisfies it). */
export interface KeyEventLike {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
}

interface Chord {
    key: string // lowercased main key
    mod: boolean // Ctrl or ⌘
    ctrl: boolean
    alt: boolean
    shift: boolean
}

export function parseChord(spec: string): Chord {
    const parts = spec.split('+').map((p) => p.trim())
    const chord: Chord = { key: '', mod: false, ctrl: false, alt: false, shift: false }
    for (const part of parts) {
        switch (part.toLowerCase()) {
            case 'mod':
                chord.mod = true
                break
            case 'ctrl':
            case 'control':
                chord.ctrl = true
                break
            case 'alt':
            case 'option':
                chord.alt = true
                break
            case 'shift':
                chord.shift = true
                break
            default:
                chord.key = part.toLowerCase()
        }
    }
    return chord
}

export function eventMatches(spec: string, event: KeyEventLike): boolean {
    const chord = parseChord(spec)
    if (event.key.toLowerCase() !== chord.key) return false
    if (chord.shift !== event.shiftKey) return false
    if (chord.alt !== event.altKey) return false
    if (chord.mod) {
        if (!(event.ctrlKey || event.metaKey)) return false
    } else {
        if (chord.ctrl !== event.ctrlKey) return false
        // A bare (no-Mod) chord must not fire when ⌘ is held alongside.
        if (!chord.ctrl && event.metaKey) return false
    }
    return true
}

/**
 * Attach the bindings to `window`, dispatching matches through the registry. Returns
 * a teardown fn. A binding whose command is missing is skipped (no throw).
 */
export function attachKeybindings(
    registry: CommandRegistry,
    bindings: Keybinding[],
    target: Window = window,
): () => void {
    const onKeydown = (event: KeyboardEvent) => {
        for (const binding of bindings) {
            if (!eventMatches(binding.key, event)) continue
            if (!registry.has(binding.command)) continue
            event.preventDefault()
            void registry.execute(binding.command, binding.arg)
            return
        }
    }
    target.addEventListener('keydown', onKeydown)
    return () => target.removeEventListener('keydown', onKeydown)
}

/**
 * Swallow browser chords that mean nothing here. Documents persist as they are typed, so
 * `Mod+S` has no work to do — left alone it opens the browser's "Save page" dialog, which
 * is startling and, for a user reaching for a save habit, suggests their edits were not
 * kept. The list is chords, not commands: nothing is dispatched, the default is just
 * prevented. Returns a teardown fn.
 */
export function suppressBrowserChords(chords: string[], target: Window = window): () => void {
    const onKeydown = (event: KeyboardEvent) => {
        if (chords.some((chord) => eventMatches(chord, event))) event.preventDefault()
    }
    target.addEventListener('keydown', onKeydown)
    return () => target.removeEventListener('keydown', onKeydown)
}

/**
 * A chord spec as a user reads it, one key cap per entry: `Mod+Shift+K` → `⌘ ⇧ K` on an Apple
 * keyboard, `Ctrl Shift K` elsewhere. The spec's own spelling stays the code's (the matcher
 * parses it; this only renders it), so a binding is written once and shown right on both
 * platforms. Pure, for the same reason the matcher is.
 */
export function formatChord(spec: string, apple: boolean): string[] {
    const chord = parseChord(spec)
    const caps: string[] = []
    if (chord.mod) caps.push(apple ? '⌘' : 'Ctrl')
    if (chord.ctrl) caps.push(apple ? '⌃' : 'Ctrl')
    if (chord.alt) caps.push(apple ? '⌥' : 'Alt')
    if (chord.shift) caps.push(apple ? '⇧' : 'Shift')
    caps.push(KEY_CAPS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key))
    return caps
}

/** Named keys whose cap reads better than their `event.key` spelling. */
const KEY_CAPS: Record<string, string> = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    enter: 'Enter',
    tab: 'Tab',
    escape: 'Esc',
    backspace: 'Backspace',
    delete: 'Delete',
    ' ': 'Space',
}

/** Whether `Mod` means ⌘ here. `platform` is deprecated but still the one field every browser fills. */
export function isApplePlatform(nav: Pick<Navigator, 'platform' | 'userAgent'> = navigator): boolean {
    return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent)
}
