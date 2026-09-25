/**
 * The spelling menu over a misspelt word (ADR 0095): its corrections, Add to the graph
 * dictionary, and Spelling languages. It is the [[Context Menu]] with a `misspelling` target,
 * raised by a right-click, Shift+F10 or the Menu key at the caret, or the Command Bar's Fix
 * spelling on a phone; the rows are registered in `commands/spelling-commands.ts`.
 *
 * Suggestions are fetched before the menu opens (Hunspell takes 7 to 50 ms), so the rows are
 * plain labels. The editor the menu was raised from is held here, because a right-click on an
 * editor in another pane does not make it the active one.
 */

import type { EditorView } from '@codemirror/view'

import { openContextMenu, type MisspellingContextMenuTarget } from '$lib/surface'

import { getActiveSpellService } from '../spelling/active-spell-service'
import type { WordRange } from '../spelling/words'

let menuView: EditorView | null = null

/** Open the menu for `hit`, at viewport `x`/`y`. */
export async function openSpellingMenu(view: EditorView, hit: WordRange, x: number, y: number): Promise<void> {
    const service = getActiveSpellService()
    const found = service ? await service.suggest(hit.word) : []
    // Hunspell answers with the dictionary's straight apostrophe; keep the writer's curly one.
    const curly = hit.word.includes('’')
    const suggestions = curly ? found.map((s) => s.replace(/'/g, '’')) : found
    menuView = view
    const target: MisspellingContextMenuTarget = { kind: 'misspelling', ...hit, suggestions }
    openContextMenu(target, x, y)
}

/**
 * The editor the open (or last) spelling menu belongs to, or null once it has gone. Never another
 * editor: a replacement meant for one document must not land in whichever is active now.
 */
function targetView(): EditorView | null {
    return menuView && menuView.dom.isConnected ? menuView : null
}

/**
 * Replace the misspelt word with `replacement`, as one ordinary edit Ctrl+Z undoes. Refused
 * (false) when the text at the target's range is no longer that word: the document changed
 * while the menu was open, and replacing blind would clobber the edit.
 */
export function replaceMisspelling(target: MisspellingContextMenuTarget, replacement: string): boolean {
    const view = targetView()
    if (!view) return false
    if (target.to > view.state.doc.length || view.state.sliceDoc(target.from, target.to) !== target.word) return false
    view.dispatch({
        changes: { from: target.from, to: target.to, insert: replacement },
        selection: { anchor: target.from + replacement.length },
        userEvent: 'input.complete',
    })
    view.focus()
    return true
}

/** Put focus back in the editor the menu came from, after a row that does not edit. */
export function focusMenuEditor(): void {
    targetView()?.focus()
}
