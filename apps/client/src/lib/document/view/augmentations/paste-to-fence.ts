/**
 * Augmentation: text pasted on a line of its own becomes the fence an extension draws for it, as a
 * YouTube or Vimeo link becomes a ```` ```video ```` block holding it, or shapes copied on
 * excalidraw.com become a drawing. The first [[Hook]]: each interactive fence registration may carry
 * `fromPaste`, which is given the pasted text and answers with the fence's body lines, or null. The
 * first that answers takes the paste.
 *
 * Only a plain-text paste (no files) onto an empty line (spaces at most) or an empty bullet (not a
 * task's), with no selection, where a block can go (not the frontmatter, a fence or a table, nor a
 * body that cannot be written) and never in a [[Protected Document]], which draws no widget. Pasted
 * inside text, the text stays text.
 *
 * Two changes, each its own undo step, so Mod+Z straight after gives back the text that was pasted,
 * as an autoformat is undone. First the text is written as a block in the caret's line, by the rule
 * `insertBlock` follows (`block-insert.ts`), rather than as an ordinary paste, whose rules reshape
 * pasted text in ways the second change could not know. Then exactly what the first wrote becomes the
 * fence, by the same rule, planned against the line as it was, so the lines around it are read as
 * they are and kept. Neither change is an `input.paste`, so no paste rule reshapes the fence either.
 *
 * Runs after `asset-paste.ts` (clipboard files are that route's) and before `rich-paste.ts`, since a
 * link copied from a page's address bar or a link on it can carry HTML beside its plain text.
 */
import { isolateHistory } from '@codemirror/commands'
import type { EditorState, Extension, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { tryGetActiveContributionRegistry } from '$lib/surface'

import { safeFenceLine } from '../../fence-body'
import { blockInsertable, blockTakesLine, insertContext, planBlockInsert } from '../block-insert'
import { INTERACTIVE_FENCE_KIND, type InteractiveFence } from './interactive-fence-contract'

/**
 * The first registered fence that takes `text`, with its body lines, or null when none does. Each
 * line an extension gave is split at any line break it holds and written so it can never close the
 * fence (`safeFenceLine`), so no answer can change the document's structure around the block.
 */
export function fenceForPaste(text: string): { info: string; lines: string[] } | null {
    const registry = tryGetActiveContributionRegistry()
    if (!registry || text.trim() === '') return null
    for (const { id, value } of registry.list(INTERACTIVE_FENCE_KIND)) {
        const fence = value as InteractiveFence
        if (!fence.fromPaste) continue
        let answer: readonly string[] | null = null
        try {
            answer = fence.fromPaste(text)
        } catch (error) {
            console.error(`[extensions] ${id}: fromPaste threw`, error)
        }
        if (!Array.isArray(answer)) continue
        const lines = answer.flatMap((line) => String(line).replace(/\r/g, '').split('\n')).map(safeFenceLine)
        return { info: id, lines }
    }
    return null
}

/** What the paste is dispatched to: the editor's view, or a headless editor in tests. */
interface PasteTarget {
    readonly state: EditorState
    dispatch(tr: Transaction): void
}

/**
 * Paste `text` as the fence a registration claims it for, or do nothing and say so (false), and the
 * editor's own paste applies.
 */
export function pasteAsFence(target: PasteTarget, text: string): boolean {
    const state = target.state
    const selection = state.selection
    if (selection.ranges.length !== 1 || !selection.main.empty) return false
    const line = state.doc.lineAt(selection.main.head)
    if (!blockTakesLine(line.text) || selection.main.head !== line.to || !blockInsertable(state)) return false
    const claimed = fenceForPaste(text)
    if (!claimed) return false

    // Both plans are for the line as it was: each takes the line's place, so the second applies to
    // exactly the text the first wrote. Windows line breaks are one line break, as the editor reads them.
    const context = insertContext(state)
    const pasted = planBlockInsert(line, context, text.split(/\r\n?|\n/))
    const fence = planBlockInsert(line, context, ['```' + claimed.info, ...claimed.lines, '```'])

    const first = state.update({ changes: { from: pasted.from, to: pasted.to, insert: pasted.insert }, selection: { anchor: pasted.caret }, userEvent: 'input.complete', scrollIntoView: true })
    target.dispatch(first)
    // Where the pasted text is now. Should anything have changed it on the way in, it stays as text.
    const from = first.changes.mapPos(pasted.from, -1)
    const to = from + pasted.insert.length
    if (target.state.sliceDoc(from, to) !== pasted.insert) return true
    target.dispatch(
        target.state.update({
            changes: { from, to, insert: fence.insert },
            // The caret beside the fence, as the plan placed it, moved with the block.
            selection: { anchor: fence.caret - pasted.from + from },
            userEvent: 'input.complete',
            annotations: isolateHistory.of('before'),
            scrollIntoView: true,
        }),
    )
    return true
}

export function pasteToFenceAugmentation(): Extension {
    return EditorView.domEventHandlers({
        paste(event, view) {
            const data = event.clipboardData
            if (!data || data.files.length > 0) return false
            if (!pasteAsFence(view, data.getData('text/plain'))) return false
            event.preventDefault()
            return true
        },
    })
}
