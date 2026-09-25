/**
 * The [[Spell Check]] augmentation: EtherPK's own underlines under misspelt prose (ADR 0095).
 *
 * The browser's checker stays off (CodeMirror's `spellcheck="false"`): inside a CodeMirror editor
 * Chrome marks a word only after a character is typed past it, and never after Enter, Backspace
 * or a caret move. This asks the spell service (`spelling/spell-service.ts`) instead and draws a
 * wavy underline under each word it calls misspelt. `spell-check-core.ts` decides which words:
 * prose only, never code, links, tags or frontmatter, never a [[Protected Document]].
 *
 * It waits for the user's first edit in the tab (`userEditedField`): a document opened to be read
 * shows no underlines, and one opened again after its tab was closed starts quiet again. From then
 * on every visible line is checked, the text that was already there included.
 *
 * When it redraws:
 * - 300 ms after an edit, with the underlines the edit overlapped gone at once and the rest moved
 *   with the text meanwhile; the word under a caret that is typing into it is left alone
 *   (`nextTypingAt`);
 * - at once when the user moves the caret off after typing, or the editor loses focus, so a word
 *   ended by an arrow key or a click is judged then;
 * - at once when lines scroll into view, the spell service answers, the preference changes, or
 *   protection changes.
 * The set depends on the text, the viewport and the service's verdicts, never on where the caret
 * merely rests: a flagged word stays flagged when the caret returns to it.
 */

import { syntaxTree } from '@codemirror/language'
import { type ChangeSet, type Extension, StateEffect, Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { isSpellCheckEnabled, subscribeSpellCheck } from '../../spell-check-preference'
import { getActiveSpellService, onActiveSpellServiceChanged } from '../../spelling/active-spell-service'
import type { WordRange } from '../../spelling/words'
import { openSpellingMenu } from '../spelling-menu'
import { protectionTick } from './protected-fence'
import { carryUserEdited, nextTypingAt, scanSpelling, spellCheckApplies, userEditedField, userHasEdited } from './spell-check-core'

const MISSPELT_CLASS = 'cm-misspelled'
const misspeltMark = Decoration.mark({ class: MISSPELT_CLASS, attributes: { 'data-misspelled': '' } })

/** Dispatched into an editor to redraw its underlines: the service answered, or the preference changed. */
export const spellCheckChanged = StateEffect.define<null>()

/** How long an edit must pause before the words it touched are judged. */
const TYPING_PAUSE_MS = 300

/**
 * Whether `changes` replaced or inserted text inside `[from, to)` (new-document positions). Text
 * typed right at a word's edge does not count, so a Space or Enter after a flagged word keeps its
 * underline rather than blinking it off for the pause.
 */
function overlapped(changes: ChangeSet, from: number, to: number): boolean {
    let hit = false
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (fromB < to && toB > from) hit = true
    })
    return hit
}

class SpellingView {
    decorations: DecorationSet
    /** The caret while an edit is in progress: the word it touches is not judged yet. */
    private typingAt: number | null = null
    private timer: ReturnType<typeof setTimeout> | undefined
    private destroyed = false
    /** A redraw already queued: the service answers every editor at once, so collapse them. */
    private refreshQueued = false
    private readonly cleanups: (() => void)[] = []

    constructor(readonly view: EditorView) {
        let serviceOff = getActiveSpellService()?.subscribe(() => this.refresh())
        this.cleanups.push(() => serviceOff?.())
        this.cleanups.push(
            onActiveSpellServiceChanged(() => {
                serviceOff?.()
                serviceOff = getActiveSpellService()?.subscribe(() => this.refresh())
                this.refresh()
            }),
        )
        this.cleanups.push(subscribeSpellCheck(() => this.refresh()))
        this.decorations = this.build()
    }

    /**
     * Redraw from outside an update. Out of the caller's stack, as the wikilink restyle and the
     * protection tick do: the service answers every editor from one loop, and a dispatch that
     * threw would stop the rest. At most one is queued at a time.
     */
    private refresh(): void {
        if (this.refreshQueued) return
        this.refreshQueued = true
        queueMicrotask(() => {
            this.refreshQueued = false
            if (!this.destroyed) this.view.dispatch({ effects: spellCheckChanged.of(null) })
        })
    }

    update(update: ViewUpdate): void {
        const caret = update.state.selection.main
        const wasTyping = this.typingAt !== null
        const carried = update.transactions.flatMap((tr) => tr.effects.filter((e) => e.is(carryUserEdited)))
        this.typingAt = nextTypingAt(this.typingAt, {
            docChanged: update.docChanged,
            typed: update.transactions.some(
                (tr) => tr.docChanged && (tr.isUserEvent('input.type') || tr.isUserEvent('delete')),
            ),
            userEdit: update.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined),
            carriedTyping: carried.some((e) => e.value.typing),
            selectionSet: update.selectionSet,
            focusLost: update.focusChanged && !update.view.hasFocus,
            caret: { empty: caret.empty, head: caret.head },
            mapPos: (pos) => update.changes.mapPos(pos),
        })

        if (update.docChanged) {
            this.decorations = this.decorations.map(update.changes).update({
                filter: (from, to) => !overlapped(update.changes, from, to),
            })
            this.schedule()
            return
        }
        const leftTyping = wasTyping && this.typingAt === null
        // The first edit itself took the branch above and draws after the pause; an edit carried
        // across a remount draws at once, as the editor it replaced was showing.
        const asked = carried.length > 0 || update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(spellCheckChanged) || e.is(protectionTick)),
        )
        if (leftTyping || asked || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
            this.decorations = this.build()
        }
    }

    /** Redraw once the edit pauses, and not in the middle of an IME composition. */
    private schedule(): void {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            if (this.destroyed) return
            if (this.view.composing) return this.schedule()
            this.view.dispatch({ effects: spellCheckChanged.of(null) })
        }, TYPING_PAUSE_MS)
    }

    private build(): DecorationSet {
        const service = getActiveSpellService()
        const { state } = this.view
        if (!service || service.state !== 'ready' || !spellCheckApplies(state, isSpellCheckEnabled())) return Decoration.none
        const scan = scanSpelling(state, this.view.visibleRanges, (word) => service.verdict(word), this.typingAt)
        // The answers arrive through the service's subscription, which redraws.
        if (scan.unknown.length > 0) void service.check(scan.unknown)
        return Decoration.set(
            scan.misspelt.map((w) => misspeltMark.range(w.from, w.to)),
            true,
        )
    }

    destroy(): void {
        this.destroyed = true
        clearTimeout(this.timer)
        for (const cleanup of this.cleanups) cleanup()
    }
}

const spellingPlugin = ViewPlugin.fromClass(SpellingView, { decorations: (v) => v.decorations })

/**
 * What a remount of a tab's editor carries into the new one: whether the user had edited, so the
 * tab stays checked, and whether they were typing, so a word they are mid-way through is not
 * flagged. Call it before the outgoing editor is torn down (its focus goes with its DOM) and apply
 * the result to the incoming one.
 */
export function carrySpellCheck(outgoing: EditorView): (incoming: EditorView) => void {
    const edited = userHasEdited(outgoing.state)
    const typing = outgoing.hasFocus
    return (incoming) => {
        if (edited) incoming.dispatch({ effects: carryUserEdited.of({ typing }) })
    }
}

/** The underlined word at `pos` (either edge counts), or null. */
export function misspellingAt(view: EditorView, pos: number | null): WordRange | null {
    if (pos === null) return null
    const plugin = view.plugin(spellingPlugin)
    let hit: WordRange | null = null
    plugin?.decorations.between(pos, pos, (from, to) => {
        hit = { from, to, word: view.state.sliceDoc(from, to) }
        return false
    })
    return hit
}

/**
 * Set when the keyboard opened the menu: Windows raises the browser's own `contextmenu` on the
 * Menu key's release, after the keydown that opened ours, and it must not open over it.
 */
let keyboardMenuAt = 0

/** The menu at the caret, for Shift+F10, the Menu key and the Command Bar's Fix spelling. */
export function openSpellingMenuAtCaret(view: EditorView): boolean {
    const hit = misspellingAt(view, view.state.selection.main.head)
    if (!hit) return false
    keyboardMenuAt = Date.now()
    const at = view.coordsAtPos(hit.to) ?? view.coordsAtPos(hit.from)
    void openSpellingMenu(view, hit, at?.left ?? 0, at?.bottom ?? 0)
    return true
}

const theme = EditorView.baseTheme({
    [`.${MISSPELT_CLASS}`]: {
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: 'var(--gk-misspelled, #d93036)',
        textDecorationThickness: '1px',
        textUnderlineOffset: '3px',
        textDecorationSkipInk: 'none',
    },
    [`&dark .${MISSPELT_CLASS}`]: { textDecorationColor: 'var(--gk-misspelled, #ff6369)' },
})

export function spellCheckAugmentation(): Extension {
    return [
        userEditedField,
        spellingPlugin,
        theme,
        EditorView.domEventHandlers({
            contextmenu(event, view) {
                // The browser's menu the Menu key raises on release, just after ours opened.
                if (Date.now() - keyboardMenuAt < 500) {
                    event.preventDefault()
                    return true
                }
                // A touch hold is native text selection on a phone; Fix spelling is its route.
                if ((event as PointerEvent).pointerType === 'touch') return false
                // Only on an underline itself: not the blank end of a line that finishes with one.
                const mark = (event.target as HTMLElement | null)?.closest?.(`.${MISSPELT_CLASS}`)
                if (!mark) return false
                const hit = misspellingAt(view, view.posAtDOM(mark, 0))
                if (!hit) return false
                // Inside a selection the browser's menu is the one with Cut, Copy and Paste.
                const selection = view.state.selection.main
                if (!selection.empty && selection.from <= hit.from && hit.to <= selection.to) return false
                event.preventDefault()
                void openSpellingMenu(view, hit, event.clientX, event.clientY)
                return true
            },
        }),
        keymap.of([
            { key: 'Shift-F10', run: openSpellingMenuAtCaret },
            { key: 'ContextMenu', run: openSpellingMenuAtCaret },
        ]),
    ]
}
