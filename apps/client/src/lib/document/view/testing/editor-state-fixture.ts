/**
 * Node-level harness for editor behaviour: a real CodeMirror `EditorState` carrying the outliner
 * keymap, the shared analysis and the transaction filters (caret clamp, block selection, frontmatter
 * boundary, paste clamp, fence guard), driven without an `EditorView` or a DOM.
 *
 * This is the fast tier of the editor's test split (Document Editor.md → *Test split*). CodeMirror's
 * own `@codemirror/commands` suite tests commands the same way, against `{ state, dispatch }`, and
 * every structural command in `outliner-keymap.ts` is a `StateCommand` for exactly this reason.
 * Anything that needs geometry (clamped hang-indents, widget heights, hit-testing) stays in the
 * Playwright specs over `/dev/editor`.
 *
 * Fixture notation (the same one the rule tables in Editor Content Rules.md use):
 *
 *   `- item|`            a caret after "item"
 *   `- «one\n- two»`     a selection from "one" to the end of "two" (anchor « … head »)
 *
 * Pass `{ caret: '¦' }` when a fixture needs a literal `|` (a table row, an image size hint).
 */

import {
    deleteCharBackward,
    deleteCharForward,
    insertBlankLine,
    insertNewlineAndIndent,
    moveLineDown,
    moveLineUp,
    redo,
    undo,
} from '@codemirror/commands'
import { EditorSelection, EditorState, type Extension, type StateCommand, type Transaction } from '@codemirror/state'
import type { Command } from '@codemirror/view'

import { editorAnalysis } from '../analysis/editor-analysis'
import { blockSelection } from '../block-select'
import { caretClamp } from '../caret-clamp'
import { fenceGuard } from '../fence-guard'
import { frontmatterBoundaryGuard } from '../frontmatter-boundary'
import { deleteHeal } from '../delete-heal'
import { leaveTidy } from '../leave-tidy'
import { localHistoryExtension } from '../editor-history'
import { outlinerBindings, outlinerKeymap } from '../outliner-keymap'
import { pasteClamp } from '../paste-clamp'
import { wrapSelectionOnInput } from '../wrap-selection'

export interface FixtureOptions {
    /** The caret marker character. Default `|`. */
    caret?: string
}

export interface ParsedFixture {
    doc: string
    anchor: number
    head: number
}

/** Strip the caret / selection markers out of `text`, returning the plain doc and the selection. */
export function parseFixture(text: string, options: FixtureOptions = {}): ParsedFixture {
    const caret = options.caret ?? '|'
    const open = text.indexOf('«')
    const close = text.indexOf('»')
    if (open >= 0 || close >= 0) {
        if (open < 0 || close < 0 || close < open) throw new Error(`Unbalanced selection markers in fixture: ${text}`)
        const doc = text.slice(0, open) + text.slice(open + 1, close) + text.slice(close + 1)
        return { doc, anchor: open, head: close - 1 }
    }
    const at = text.indexOf(caret)
    if (at < 0) throw new Error(`Fixture has no caret marker (${caret}): ${text}`)
    if (text.indexOf(caret, at + 1) >= 0) throw new Error(`Fixture has more than one caret marker: ${text}`)
    const doc = text.slice(0, at) + text.slice(at + caret.length)
    return { doc, anchor: at, head: at }
}

/** Render a state back into fixture notation: the doc with the main selection marked. */
export function renderFixture(state: EditorState, options: FixtureOptions = {}): string {
    const caret = options.caret ?? '|'
    const doc = state.doc.toString()
    const sel = state.selection.main
    if (sel.empty) return doc.slice(0, sel.head) + caret + doc.slice(sel.head)
    // A selection renders left to right whichever end is the head; `head()` says which.
    return doc.slice(0, sel.from) + '«' + doc.slice(sel.from, sel.to) + '»' + doc.slice(sel.to)
}

export interface EditorFixtureOptions extends FixtureOptions {
    /** Extra extensions to load beside the standard editor stack. */
    extensions?: Extension[]
    /**
     * Leave out the transaction filters (caret clamp, block selection, fence guard). Default false:
     * the filters are part of the behaviour the rule tables describe.
     */
    withoutFilters?: boolean
}

/**
 * Default handlers for the keys the outliner layer yields on, mirroring the `defaultKeymap` and
 * `historyKeymap` entries that sit under it in `cm-document.ts`. Only the keys the rule tables use.
 */
const DEFAULT_KEY_HANDLERS: Record<string, StateCommand> = {
    Enter: insertNewlineAndIndent,
    'Mod-Enter': insertBlankLine,
    // Typed as `Command` upstream but implemented over `{ state, dispatch }` only.
    Backspace: stateOnly(deleteCharBackward),
    Delete: stateOnly(deleteCharForward),
    'Alt-ArrowUp': stateOnly(moveLineUp),
    'Alt-ArrowDown': stateOnly(moveLineDown),
    'Mod-z': undo,
    'Mod-y': redo,
}

/** Treat a view-typed command that only reads `state` and calls `dispatch` as a state command. */
function stateOnly(command: Command): StateCommand {
    return command as unknown as StateCommand
}

/** A headless editor: state plus the same dispatch surface a `StateCommand` sees in a live view. */
export class HeadlessEditor {
    state: EditorState
    private readonly options: FixtureOptions

    constructor(state: EditorState, options: FixtureOptions = {}) {
        this.state = state
        this.options = options
    }

    dispatch = (tr: Transaction): void => {
        this.state = tr.state
    }

    /** The document plus caret / selection in fixture notation. */
    fixture(options: FixtureOptions = this.options): string {
        return renderFixture(this.state, options)
    }

    text(): string {
        return this.state.doc.toString()
    }

    head(): number {
        return this.state.selection.main.head
    }

    /**
     * Press a key by CodeMirror name (`Enter`, `Shift-Tab`, `Alt-ArrowUp`, `Mod-Enter`, …): the
     * outliner bindings for that key run in order until one handles it, exactly like the live keymap,
     * then the default handler applies. Returns whether anything handled the key.
     */
    key(name: string): boolean {
        for (const binding of outlinerBindings()) {
            if (binding.key !== name || !binding.run) continue
            if (binding.run(this as never)) return true
        }
        const fallback = DEFAULT_KEY_HANDLERS[name]
        return fallback ? fallback(this) : false
    }

    /**
     * Type text over the selection the way the live input handler sees it (wrap-selection.ts): a
     * wrap key over a selection encloses it, anything else is the ordinary typed replace.
     */
    type(text: string): void {
        const wrapped = wrapSelectionOnInput(this.state, text)
        this.dispatch(this.state.update(wrapped ?? { ...this.state.replaceSelection(text), userEvent: 'input.type' }))
    }

    /** Paste (or drop) text over the selection, the way CodeMirror's clipboard handling dispatches it. */
    paste(text: string, event: 'input.paste' | 'input.drop' = 'input.paste'): void {
        this.dispatch(this.state.update(this.state.replaceSelection(text), { userEvent: event }))
    }

    /** Cut the selection, the way CodeMirror's cut handler dispatches it (the text itself is not kept here). */
    cut(): void {
        this.dispatch(this.state.update(this.state.replaceSelection(''), { userEvent: 'delete.cut' }))
    }

    /** Move the caret (or set a selection) without any edit. */
    select(anchor: number, head = anchor): void {
        this.dispatch(this.state.update({ selection: EditorSelection.single(anchor, head), userEvent: 'select' }))
    }
}

/** Build a headless editor from fixture notation with the standard editor stack loaded. */
export function editorFixture(text: string, options: EditorFixtureOptions = {}): HeadlessEditor {
    const { extensions = [], withoutFilters = false } = options
    const parsed = parseFixture(text, options)
    const state = EditorState.create({
        doc: parsed.doc,
        selection: EditorSelection.single(parsed.anchor, parsed.head),
        extensions: [
            localHistoryExtension(),
            outlinerKeymap(),
            editorAnalysis(),
            // The live order: cm-document.ts registers the fence guard, paste clamp and delete heal,
            // then the feature stack (editor-extensions.ts) adds block selection, the caret clamp and
            // the frontmatter guard AFTER them. Filters run last-registered first, so the clamp runs
            // before the delete heal, and the paste clamp sees the raw paste before the guard re-pads
            // what is left. A fixture in another order passes rows the browser fails (the heal's caret).
            ...(withoutFilters ? [] : [leaveTidy(), fenceGuard(), pasteClamp(), deleteHeal(), blockSelection(), caretClamp(), frontmatterBoundaryGuard()]),
            ...extensions,
        ],
    })
    return new HeadlessEditor(state, options)
}

/** Shorthand: press one key on a fixture and return the result in fixture notation. */
export function press(before: string, key: string, options: EditorFixtureOptions = {}): string {
    const editor = editorFixture(before, options)
    editor.key(key)
    return editor.fixture()
}
