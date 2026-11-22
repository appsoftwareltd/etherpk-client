/**
 * Path completion: while a markdown link's destination is typed in a file of a [[Plain Folder]],
 * a popover offers the folder's files, each as the relative link from the file being edited.
 *
 * It is the plain profile's stand-in for wikilink completion, on the same popover primitive
 * (popover-menu.ts), so the rows, the keys and the placement are the ones a `[[` has in a graph.
 * What to offer is decided outside the editor (plain/path-complete-core.ts); this finds the
 * destination under the caret and writes the chosen link into it.
 */
import type { EditorState, Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { type PathSuggestion, openLinkSlot, restOfDestination } from '#lib/plain/path-complete-core.js'
import { iconSvg } from '#lib/surface/icons.js'

import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'
import { type PopoverBase, type PopoverRow, popoverMenu } from './popover-menu'

export interface PathCompletionOptions {
    /** The files to offer for the destination typed so far. */
    suggest: (query: string) => PathSuggestion[]
}

interface MenuState extends PopoverBase {
    /** Where the destination starts, and where what is replaced ends. */
    from: number
    to: number
    /** A `)` already closes the destination, so none is written. */
    closed: boolean
    items: PathSuggestion[]
}

export function pathCompletion(options: PathCompletionOptions): Extension {
    function compute(state: EditorState): MenuState | null {
        const selection = state.selection.main
        if (!selection.empty) return null
        const caret = selection.head
        const line = state.doc.lineAt(caret)
        const slot = openLinkSlot(state.sliceDoc(line.from, caret))
        if (!slot) return null
        const anchor = line.from + slot.open
        const analysis = analysisFor(state)
        if (isInCode(analysis.codeRanges, anchor, caret) || analysis.frontmatterEnd >= anchor) return null
        const rest = restOfDestination(state.sliceDoc(caret, line.to))
        const from = line.from + slot.queryFrom
        const items = options.suggest(state.sliceDoc(from, caret))
        if (items.length === 0) return null
        return { anchor, from, to: caret + rest.length, closed: rest.closed, items, selected: 0 }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({
            label: item.label,
            detail: item.detail,
            icon: iconSvg(item.icon, { strokeWidth: 1.3 }),
            dataAttrs: { 'data-path': item.path },
        }))
    }

    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        const item = menu.items[index]
        if (!item) return false
        const insert = menu.closed ? item.href : `${item.href})`
        // The caret ends after the link's `)`: the one just written, or the one already there.
        const after = menu.from + item.href.length + 1
        view.dispatch({ changes: { from: menu.from, to: menu.to, insert }, selection: { anchor: after }, userEvent: 'input.complete' })
        return true
    }

    return popoverMenu<MenuState>({ testid: 'path-completion', classPrefix: 'gk-path-complete', compute, rows, accept })
}
