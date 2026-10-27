/**
 * The editor's side of [[Find and Replace]] (ADR 0153): the [[Match]]es the box found, washed in
 * the text, the current one marked apart, and Esc closing the box before it blurs the editor.
 *
 * The box works out the matches (`find/find-matches.ts`) and sends them here with
 * `showFindMatches`. Between two searches the marks are carried through every change, so they
 * stay on their text while another member types, and the box reads match positions from here
 * rather than from its own copy, which is only as new as its last search. The current match is
 * also the editor's selection (`selectMatch`), which is what makes the reveal policy show the
 * markup around it. Whether the selection is still find's is kept here too: the caret clamp and
 * the block selection reshape a selection that starts in a bullet's margin or crosses blocks, so
 * comparing the selection with the match cannot tell.
 */

import { foldedRanges, unfoldEffect } from '@codemirror/language'
import { type EditorState, type Extension, Prec, RangeSetBuilder, StateEffect, StateField, Transaction, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, showTooltip, ViewPlugin } from '@codemirror/view'

import { FIND_SELECT_EVENT, isFindSelect } from '../../find/find-edit'
import { isOwnEditing } from '../own-editing'
import { FIND_TARGET_GONE, FIND_TEXT_CHANGED, requestFind } from '../../find/find-events'

export interface FindRange {
    from: number
    to: number
}

/** The matches to show and which of them is current, or null to show none (the box closed). */
export interface FindShown {
    ranges: readonly FindRange[]
    /** The index of the current match, or -1 for none. */
    current: number
}

/** Show these matches, or, with null, none: find is closed. */
export const showFindMatches = StateEffect.define<FindShown | null>()

/** Make the match at this index the current one. */
export const setCurrentMatch = StateEffect.define<number>()

interface FindFieldValue {
    open: boolean
    ranges: readonly FindRange[]
    current: number
    /** The selection is the one find put on the current match, and the user has not moved it since. */
    selected: boolean
    decorations: DecorationSet
}

const CLOSED: FindFieldValue = { open: false, ranges: [], current: -1, selected: false, decorations: Decoration.none }

const sameRange = (a: FindRange | undefined, b: FindRange | undefined) => !!a && !!b && a.from === b.from && a.to === b.to

const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-match cm-find-current' })

/** The marks for `ranges`, which come sorted and apart, as a search cursor gives them. */
function marksFor(ranges: readonly FindRange[], current: number): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    ranges.forEach((range, index) => {
        // An empty match (a regular expression such as `^`) has no text to wash.
        if (range.to > range.from) builder.add(range.from, range.to, index === current ? currentMark : matchMark)
    })
    return builder.finish()
}

const findField = StateField.define<FindFieldValue>({
    create: () => CLOSED,
    update(value, tr) {
        let { open, ranges, current, selected } = value
        let shown = false
        if (open && tr.docChanged) {
            ranges = ranges.map((range) => {
                const from = tr.changes.mapPos(range.from, 1)
                return { from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) }
            })
        }
        for (const effect of tr.effects) {
            if (effect.is(showFindMatches)) {
                if (!effect.value) return CLOSED
                // New matches keep the selection find's only while the same match is current.
                selected = selected && sameRange(ranges[current], effect.value.ranges[effect.value.current])
                ;({ ranges, current } = effect.value)
                open = shown = true
            } else if (effect.is(setCurrentMatch)) {
                current = effect.value
            }
        }
        if (!open) return value
        if (isFindSelect(tr)) selected = true
        // The user moved the caret, or typed: the selection is theirs now.
        else if (tr.selection || (tr.docChanged && isOwnEditing(tr))) selected = false
        const moved = shown || current !== value.current || ranges !== value.ranges
        return {
            open,
            ranges,
            current,
            selected,
            decorations: moved ? marksFor(ranges, current) : value.decorations,
        }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** Whether find is open on this editor's document. */
export function findIsOpen(state: EditorState): boolean {
    return state.field(findField, false)?.open ?? false
}

/**
 * The matches shown and the current one, as last sent and carried through every change since, and
 * whether the selection is still the one find put on the current match.
 */
export function findState(state: EditorState): { ranges: readonly FindRange[]; current: number; selected: boolean } {
    const value = state.field(findField, false) ?? CLOSED
    return { ranges: value.ranges, current: value.current, selected: value.selected }
}

/** The marks drawn for the matches. */
export function findDecorations(state: EditorState): DecorationSet {
    return state.field(findField, false)?.decorations ?? Decoration.none
}

/**
 * Put the selection on a match, and with `index` make it the current one: marked as find's
 * (`select.find`), so no popover opens on it, with every fold that hides it opened and the match
 * scrolled into view. Other folds stay shut, since a fold is view state the user chose. A caret the
 * app places, it goes in out of the undo history, so tidy on leave writes nothing to the line it
 * leaves (leave-tidy.ts): the user did not walk away from it.
 */
export function selectMatch(state: EditorState, range: FindRange, index?: number): TransactionSpec {
    const effects: StateEffect<unknown>[] = []
    foldedRanges(state).between(range.from, range.to, (from, to) => {
        effects.push(unfoldEffect.of({ from, to }))
    })
    effects.push(EditorView.scrollIntoView(range.from, { y: 'nearest', yMargin: 64 }))
    if (index !== undefined) effects.push(setCurrentMatch.of(index))
    return {
        selection: { anchor: range.from, head: range.to },
        effects,
        userEvent: FIND_SELECT_EVENT,
        annotations: Transaction.addToHistory.of(false),
    }
}

/**
 * Tells the find host when the text of an editor find is open on changes, or the editor goes, so
 * the box works the matches out again or lets the editor go. The marks meanwhile follow the text.
 */
const tellFindHost = ViewPlugin.define((view) => ({
    update(update) {
        if (update.docChanged && findIsOpen(update.state)) view.dom.dispatchEvent(new CustomEvent(FIND_TEXT_CHANGED, { bubbles: true }))
    },
    destroy() {
        if (findIsOpen(view.state)) view.dom.dispatchEvent(new CustomEvent(FIND_TARGET_GONE, { bubbles: true, detail: { view } }))
    },
}))

/** Room above a match scrolled into view, so the box over the top of the View does not cover it. */
const FIND_BOX_ROOM = 96

/**
 * The find feature for the editor stack. Esc closes the box first and blurs the editor only when
 * pressed again. Highest precedence, since the outliner's Esc sits at high and is registered first,
 * but it gives way while a popover is showing, so an open completion or menu closes first.
 */
export function findHighlight(): Extension {
    return [
        findField,
        tellFindHost,
        Prec.highest(
            keymap.of([
                {
                    key: 'Escape',
                    run: (view) => findIsOpen(view.state) && !view.state.facet(showTooltip).some(Boolean) && requestFind(view.dom, 'close', view),
                },
            ]),
        ),
        EditorView.scrollMargins.of((view) => (findIsOpen(view.state) ? { top: FIND_BOX_ROOM } : null)),
        EditorView.baseTheme({
            '.cm-find-match': {
                background: 'var(--gk-find-match, rgba(234, 88, 12, 0.12))',
                borderRadius: '2px',
            },
            '.cm-find-current': {
                background: 'var(--gk-find-current, rgba(234, 88, 12, 0.25))',
                boxShadow: '0 0 0 1px var(--gk-find-current-border, #c2410c)',
            },
        }),
    ]
}
