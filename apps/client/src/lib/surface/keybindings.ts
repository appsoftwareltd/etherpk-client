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
    /**
     * The one platform the chord is bound on: `apple` for a Mac, iPhone or iPad, `other` for the
     * rest. Absent, it is bound everywhere. Ctrl+H opens replace on Windows and Linux, but on a Mac
     * it deletes backwards in a text field, so the Mac has its own chord.
     */
    platform?: 'apple' | 'other'
    /**
     * Whether the chord is the app's just now. While this says no, the key is left to the browser
     * and nothing is prevented: Mod+F finds in the document in front, and in the browser's own
     * way anywhere else.
     */
    when?: () => boolean
}

/** The shape of a keyboard event the matcher needs (a real KeyboardEvent satisfies it). */
export interface KeyEventLike {
    key: string
    /** The physical key (`KeyF`), which a chord with Mod and Alt matches on. */
    code?: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
    /**
     * Whether AltGr is held (`getModifierState('AltGraph')`). A Windows layout reports AltGr as Ctrl
     * and Alt, and AltGr types a character, so a Ctrl and Alt chord does not take it.
     */
    altGraph?: boolean
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
    if (event.key.toLowerCase() !== chord.key && !sameLetterKey(chord, event)) return false
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
 * Whether a Mod and Alt, or Ctrl and Alt, chord's letter is the key pressed, read from its place on
 * the keyboard. On a Mac, Option changes the character a key types (Cmd+Option+F reports `ƒ`,
 * Ctrl+Option+K `˚`), and with Mod or Ctrl held nothing is being typed. AltGr, which a Windows
 * layout reports as Ctrl and Alt, is typing, so it keeps its character. A bare Alt chord keeps
 * matching by character, so Option still types `∆`.
 */
function sameLetterKey(chord: Chord, event: KeyEventLike): boolean {
    if (!chord.alt || !(chord.mod || chord.ctrl) || altGraphHeld(event)) return false
    return /^[a-z]$/.test(chord.key) && event.code === `Key${chord.key.toUpperCase()}`
}

/** AltGr from the event: the field a test sets, or a real KeyboardEvent's modifier state. */
function altGraphHeld(event: KeyEventLike): boolean {
    if (event.altGraph !== undefined) return event.altGraph
    const state = (event as Partial<Pick<KeyboardEvent, 'getModifierState'>>).getModifierState
    return typeof state === 'function' && state.call(event, 'AltGraph')
}

/** Whether `binding` is bound on this platform (`apple` for a Mac, iPhone or iPad). */
export function boundOnPlatform(binding: Pick<Keybinding, 'platform'>, apple: boolean): boolean {
    return binding.platform === undefined || binding.platform === (apple ? 'apple' : 'other')
}

/** Whether two chord specs name the same keys: `Alt+Shift+P` and `shift+alt+p` do. */
export function sameChord(a: string, b: string): boolean {
    const left = parseChord(a)
    const right = parseChord(b)
    return left.key === right.key && left.mod === right.mod && left.ctrl === right.ctrl && left.alt === right.alt && left.shift === right.shift
}

/**
 * The app's chords as one live list, which extensions add to as they start (ADR 0121) and which
 * `attachKeybindings` reads on every key, so an added chord works at once. Two bindings for one
 * chord would leave which one runs to the order they were added in, so a second is refused.
 */
export function createKeybindingTable<B extends Keybinding>(initial: readonly B[]) {
    const bindings: B[] = [...initial]
    // Whoever shows a chord (the Graph Sidebar's help text) hears when one is added or taken out,
    // because an extension can bind a chord after that surface has drawn.
    const listeners = new Set<() => void>()
    const changed = () => {
        for (const listener of listeners) listener()
    }
    return {
        bindings,
        /** Add a binding. Throws if its chord is bound already. Returns the removal. */
        add(binding: B): () => void {
            const taken = bindings.find((bound) => sameChord(bound.key, binding.key))
            if (taken) throw new Error(`${binding.key} is bound already, to ${taken.command}.`)
            bindings.push(binding)
            changed()
            return () => {
                const at = bindings.indexOf(binding)
                if (at < 0) return
                bindings.splice(at, 1)
                changed()
            }
        },
        /** Be told whenever a binding is added or taken out. Returns the unsubscribe. */
        subscribe(listener: () => void): () => void {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

/** The live table of the app's chords, as `createKeybindingTable` makes it. */
export type KeybindingTable<B extends Keybinding = Keybinding> = ReturnType<typeof createKeybindingTable<B>>

/**
 * Every chord bound to `command`, in the order the table holds them: on the platform named
 * (`apple` true or false), or on every platform when none is.
 */
export function chordsFor(bindings: readonly Keybinding[], command: string, apple?: boolean): string[] {
    return bindings
        .filter((binding) => binding.command === command && (apple === undefined || boundOnPlatform(binding, apple)))
        .map((binding) => binding.key)
}

/**
 * Attach the bindings to `window`, dispatching matches through the registry. Returns
 * a teardown fn. A binding whose command is missing is skipped (no throw).
 */
export function attachKeybindings(
    registry: CommandRegistry,
    bindings: Keybinding[],
    target: Window = window,
    apple: boolean = isApplePlatform(),
): () => void {
    const onKeydown = (event: KeyboardEvent) => {
        for (const binding of bindings) {
            if (!boundOnPlatform(binding, apple)) continue
            if (!eventMatches(binding.key, event)) continue
            if (!registry.has(binding.command)) continue
            if (binding.when && !binding.when()) continue
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

/**
 * A chord as help text writes it: `Ctrl + K` on Windows and Linux, and `⌘K` on an Apple keyboard,
 * where a menu runs the symbols together.
 */
export function formatChordHint(spec: string, apple: boolean): string {
    return formatChord(spec, apple).join(apple ? '' : ' + ')
}

/**
 * A chord as `aria-keyshortcuts` names it (`Control+K`, `Meta+K`, `Alt+Shift+P`): the
 * KeyboardEvent key values a screen reader reads out, `Mod` resolved for the platform.
 */
export function ariaKeyShortcut(spec: string, apple: boolean): string {
    const chord = parseChord(spec)
    const keys: string[] = []
    if (chord.mod) keys.push(apple ? 'Meta' : 'Control')
    if (chord.ctrl) keys.push('Control')
    if (chord.alt) keys.push('Alt')
    if (chord.shift) keys.push('Shift')
    keys.push(ARIA_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key))
    return keys.join('+')
}

/** Named keys by their KeyboardEvent key value, which `aria-keyshortcuts` uses. */
const ARIA_KEYS: Record<string, string> = {
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    enter: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    ' ': 'Space',
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
