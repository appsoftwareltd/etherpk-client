/**
 * Typing inside [[Frontmatter]]: the keys that keep YAML indentation right (ADR 0108,
 * Editor Content Rules.md → Frontmatter).
 *
 * YAML reads its structure from indentation, and a hand-edited block goes wrong most often there:
 * a tab (YAML forbids tabs as indentation), or a list item one space off its siblings. So inside
 * the block the editor indents for the person, always by two spaces and never with a tab:
 *
 * - Enter keeps the line's indent, goes one level in after a key with no value (`aliases:`), and
 *   continues a list with the next `- `. Enter creates and never escapes (ADR 0019), as it does in
 *   the outline, even on an empty item; Mod+Enter is the way out, one level up.
 * - Tab and Shift+Tab indent and outdent the line (or every line of a selection) by two spaces.
 * - Backspace on an empty list item removes the marker with its indent; in the indentation it
 *   removes one level.
 * - A pasted tab indent becomes two spaces a level.
 *
 * Only lines between the delimiters are handled: the delimiter lines are the block's edges, and
 * the keys there behave as they do in the body. The bindings sit above the outliner keymap, which
 * otherwise consumes Tab in the block and treats a YAML list item as a bullet.
 *
 * Select all is bound here as well, at the same precedence, though it acts in the body too: it
 * keeps to one side of the block's edge, so the command lives with the edge rules in
 * `frontmatter-boundary.ts`.
 */

import { EditorSelection, EditorState, type Extension, Prec, type StateCommand, Transaction, type TransactionSpec } from '@codemirror/state'
import { type KeyBinding, keymap } from '@codemirror/view'

import { isFrontmatterDelimiter } from '$lib/storage/fs/frontmatter-span'

import { analysisFor } from './analysis/editor-analysis'
import { selectAllOnOneSideOfFrontmatter } from './frontmatter-boundary'
import { isFrontmatterBodyLine } from './frontmatter-text'

/** The YAML indent unit EtherPK writes (ADR 0108). */
const UNIT = '  '

/** A list item's marker and the indent before it: `  - `. */
const ITEM = /^( *)- ?/

/** A key with nothing after its colon, so the next line holds its value one level in. */
const BARE_KEY = /^ *[^\s#-][^:]*:\s*$/

/** The caret's line when the selection is a single caret on a line inside the block, else null. */
function caretLine(state: EditorState) {
    const selection = state.selection
    if (selection.ranges.length !== 1 || !selection.main.empty) return null
    const line = state.doc.lineAt(selection.main.head)
    return isFrontmatterBodyLine(state, line.number) ? line : null
}

/** Dispatch `spec` over `state` and report the key handled. */
function apply(target: { state: EditorState; dispatch: (tr: Transaction) => void }, spec: TransactionSpec): true {
    target.dispatch(target.state.update(spec))
    return true
}

/** Enter: the next line at the right indent, or the next list item. */
const enter: StateCommand = ({ state, dispatch }) => {
    const line = caretLine(state)
    if (!line) return false
    const head = state.selection.main.head
    const column = head - line.from
    const indent = /^ */.exec(line.text)![0]
    const item = ITEM.exec(line.text)
    let insert: string
    if (item && column >= item[0].length) insert = `\n${item[1]}- `
    else if (BARE_KEY.test(line.text) && column >= line.text.trimEnd().length) insert = `\n${indent}${UNIT}`
    else insert = `\n${indent.slice(0, Math.min(column, indent.length))}`
    return apply({ state, dispatch }, {
        changes: { from: head, insert },
        selection: EditorSelection.cursor(head + insert.length),
        scrollIntoView: true,
        userEvent: 'input',
    })
}

/**
 * Mod+Enter: a new line one level out from the line's own level, the line left whole. From an
 * empty list item the item itself becomes that line, so no empty entry is left behind.
 */
const leave: StateCommand = ({ state, dispatch }) => {
    const line = caretLine(state)
    if (!line) return false
    const item = ITEM.exec(line.text)
    const level = (item ? item[1] : /^ */.exec(line.text)![0]).length
    const outer = ' '.repeat(Math.max(0, level - UNIT.length))
    if (/^ *- ?$/.test(line.text)) {
        return apply({ state, dispatch }, {
            changes: { from: line.from, to: line.to, insert: outer },
            selection: EditorSelection.cursor(line.from + outer.length),
            userEvent: 'input',
        })
    }
    const insert = `\n${outer}`
    return apply({ state, dispatch }, {
        changes: { from: line.to, insert },
        selection: EditorSelection.cursor(line.to + insert.length),
        scrollIntoView: true,
        userEvent: 'input',
    })
}

/**
 * The block lines the main selection touches, or null when any of them is outside the block. A
 * selection ending at the very start of a line does not take that line in, as CodeMirror's own
 * indent commands have it: a selection of whole lines ends at the start of the next one.
 */
function selectedBlockLines(state: EditorState): { from: number; number: number; text: string }[] | null {
    const { from, to } = state.selection.main
    const first = state.doc.lineAt(from).number
    const end = state.doc.lineAt(to)
    const last = to > from && to === end.from ? end.number - 1 : end.number
    const lines = []
    for (let n = first; n <= last; n++) {
        if (!isFrontmatterBodyLine(state, n)) return null
        lines.push(state.doc.line(n))
    }
    return lines
}

/** Tab: every selected line two spaces in. */
const indent: StateCommand = ({ state, dispatch }) => {
    const lines = selectedBlockLines(state)
    if (!lines) return false
    const changes = state.changes(lines.map((line) => ({ from: line.from, insert: UNIT })))
    const { anchor, head } = state.selection.main
    // Mapped forwards, so a caret at the start of its line moves in with the text.
    return apply({ state, dispatch }, {
        changes,
        selection: EditorSelection.single(changes.mapPos(anchor, 1), changes.mapPos(head, 1)),
        userEvent: 'input.indent',
    })
}

/** Shift+Tab: every selected line up to two spaces out. */
const outdent: StateCommand = ({ state, dispatch }) => {
    const lines = selectedBlockLines(state)
    if (!lines) return false
    const removals = lines.map((line) => ({ from: line.from, to: line.from + Math.min(UNIT.length, /^ */.exec(line.text)![0].length) }))
    // An indented `---` (inside a block scalar) outdented to the margin would be a delimiter and
    // close the block early, turning the keys below it into body text: refused, the key consumed.
    if (lines.some((line, i) => isFrontmatterDelimiter(line.text.slice(removals[i].to - line.from)))) return true
    const changes = state.changes(removals.filter((r) => r.to > r.from))
    if (changes.empty) return true
    const { anchor, head } = state.selection.main
    return apply({ state, dispatch }, {
        changes,
        selection: EditorSelection.single(changes.mapPos(anchor, -1), changes.mapPos(head, -1)),
        userEvent: 'delete.dedent',
    })
}

/** Backspace: an empty item goes whole; in the indentation, one level goes. */
const backspace: StateCommand = ({ state, dispatch }) => {
    const line = caretLine(state)
    if (!line) return false
    const head = state.selection.main.head
    const column = head - line.from
    if (/^ *- ?$/.test(line.text) && column === line.text.length) {
        return apply({ state, dispatch }, {
            changes: { from: line.from, to: line.to },
            selection: EditorSelection.cursor(line.from),
            userEvent: 'delete.backward',
        })
    }
    const before = line.text.slice(0, column)
    if (column > 0 && /^ +$/.test(before)) {
        let width = column % UNIT.length === 0 ? UNIT.length : column % UNIT.length
        // Never outdent an indented `---` to the margin, where it would close the block early. One
        // space goes instead; CodeMirror's own Backspace would take the whole level.
        if (isFrontmatterDelimiter(line.text.slice(0, column - width) + line.text.slice(column))) width = 1
        // With one space left, any Backspace would make the delimiter: refused, the key consumed.
        if (isFrontmatterDelimiter(line.text.slice(0, column - width) + line.text.slice(column))) return true
        return apply({ state, dispatch }, {
            changes: { from: head - width, to: head },
            selection: EditorSelection.cursor(head - width),
            userEvent: 'delete.backward',
        })
    }
    return false
}

/** The bindings, for the live keymap and the rule tables. */
export function frontmatterBindings(): KeyBinding[] {
    return [
        { key: 'Enter', run: enter as KeyBinding['run'] },
        { key: 'Mod-Enter', run: leave as KeyBinding['run'] },
        { key: 'Tab', run: indent as KeyBinding['run'] },
        { key: 'Shift-Tab', run: outdent as KeyBinding['run'] },
        { key: 'Backspace', run: backspace as KeyBinding['run'] },
        { key: 'Mod-a', run: selectAllOnOneSideOfFrontmatter as KeyBinding['run'] },
    ]
}

/** A tab indent in pasted text, as the two spaces a level YAML needs. */
function spacedIndent(text: string): string {
    return text.replace(/(^|\n)(\t+)/g, (_, start: string, tabs: string) => start + UNIT.repeat(tabs.length))
}

/**
 * A paste or drop landing wholly inside the block has its tab indents written as spaces. The
 * reshaped transaction keeps the paste's user event (sub-events included), effects and scrolling,
 * and its selection mapped onto the respaced text: a drop still selects what was dropped.
 */
const pasteTabsAsSpaces = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !(tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) return tr
    const end = analysisFor(tr.startState).frontmatterEnd
    if (end < 0) return tr
    let needed = false
    let inside = true
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (fromA <= openerEnd(tr.startState) || toA > tr.startState.doc.lineAt(end).from) inside = false
        if (/(^|\n)\t/.test(inserted.toString())) needed = true
    })
    if (!inside || !needed) return tr
    const specs: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => specs.push({ from: fromA, to: toA, insert: spacedIndent(inserted.toString()) }))
    const changes = tr.startState.changes(specs)
    // Each end of the paste's own selection, taken back to the old text and forward over the new.
    const back = tr.changes.invertedDesc
    const remap = (pos: number, assoc: -1 | 1) => changes.mapPos(back.mapPos(pos, assoc), assoc)
    const selection = EditorSelection.create(
        tr.newSelection.ranges.map((range) =>
            range.empty
                ? EditorSelection.cursor(remap(range.head, 1))
                : range.anchor < range.head
                  ? EditorSelection.range(remap(range.anchor, -1), remap(range.head, 1))
                  : EditorSelection.range(remap(range.anchor, 1), remap(range.head, -1)),
        ),
        tr.newSelection.mainIndex,
    )
    return {
        changes,
        selection,
        effects: tr.effects,
        scrollIntoView: tr.scrollIntoView,
        userEvent: tr.annotation(Transaction.userEvent),
    }
})

/** The end of the opening delimiter's line: a paste must start after it to be inside the block. */
function openerEnd(state: EditorState): number {
    return state.doc.line(1).to
}

/** The frontmatter keys and the paste rule, above the outliner's bindings. */
export function frontmatterKeys(): Extension {
    return [Prec.highest(keymap.of(frontmatterBindings())), pasteTabsAsSpaces]
}
