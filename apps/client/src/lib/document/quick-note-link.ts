/**
 * Wikilinks in a plain text box: the [[Quick Notes View]]'s and the [[Share Target]]'s.
 *
 * A textarea has no editor behind it, so the three things the document editor does for a link
 * are done here over a string and a caret: wrapping a selection, finding the open `[[` the
 * caret is in, and writing the chosen name. The context and the ranking are the editor's own
 * (`wikilink-complete-core.ts`), so a name ranks the same in a note as in a document.
 *
 * Pure: the component holds the textarea and turns each result into a value and a selection.
 */
import type { ConceptCandidate } from './index-db'
import {
    closingBracketOffset,
    openWikilinkContext,
    queryForWikilinkCompletion,
    rankWikilinkCompletions,
    type WikilinkCompletion,
} from './view/augmentations/wikilink-complete-core'

/** A box shows a few names, not the editor's forty: the list sits between the text and Add. */
export const MAX_QUICK_NOTE_LINK_ROWS = 6

export interface TextSelection {
    text: string
    from: number
    to: number
}

/**
 * `[[ ]]` pressed, or `[` typed over a selection. A selection is wrapped, its outer spaces left
 * outside the brackets, and the caret lands after the link. With nothing selected an empty pair
 * goes in at the caret, which lands between the brackets, where typing a name completes it.
 * Null for a selection that spans lines: a link's name is one line.
 */
export function surroundWithWikilink(text: string, anchor: number, head: number): TextSelection | null {
    let from = Math.min(anchor, head)
    let to = Math.max(anchor, head)
    if (from === to) {
        return { text: `${text.slice(0, from)}[[]]${text.slice(to)}`, from: from + 2, to: from + 2 }
    }
    if (text.slice(from, to).includes('\n')) return null
    while (from < to && text[from] === ' ') from += 1
    while (to > from && text[to - 1] === ' ') to -= 1
    const end = to + 4
    return { text: `${text.slice(0, from)}[[${text.slice(from, to)}]]${text.slice(to)}`, from: end, to: end }
}

/** The caret's line, split at the caret, and where that line starts in the whole text. */
function caretLine(text: string, caret: number): { lineStart: number; prefix: string; suffix: string } {
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1
    const lineEnd = text.indexOf('\n', caret)
    return {
        lineStart,
        prefix: text.slice(lineStart, caret),
        suffix: text.slice(caret, lineEnd === -1 ? text.length : lineEnd),
    }
}

/**
 * The name to rank while the caret is inside a link, or null outside one. Inside a link that is
 * already closed it is the whole name, as in the editor.
 */
export function quickNoteLinkQuery(text: string, caret: number): string | null {
    const { prefix, suffix } = caretLine(text, caret)
    const context = openWikilinkContext(prefix)
    return context ? queryForWikilinkCompletion(context, suffix) : null
}

/** The names to offer at `caret`: none outside a link, and a "new" row last for a name no page has. */
export function quickNoteLinkRows(
    candidates: readonly ConceptCandidate[],
    text: string,
    caret: number,
): WikilinkCompletion[] {
    const query = quickNoteLinkQuery(text, caret)
    if (query === null) return []
    const rows = rankWikilinkCompletions(candidates, query)
    const create = rows.at(-1)?.kind === 'create' ? rows.at(-1)! : null
    const named = (create ? rows.slice(0, -1) : rows).slice(0, MAX_QUICK_NOTE_LINK_ROWS - (create ? 1 : 0))
    return create ? [...named, create] : named
}

/**
 * Write `name` as the link the caret is in, using the `]]` already on the line when there is
 * one, and put the caret after it. Null outside a link.
 */
export function acceptQuickNoteLink(text: string, caret: number, name: string): { text: string; caret: number } | null {
    const { lineStart, prefix, suffix } = caretLine(text, caret)
    const context = openWikilinkContext(prefix)
    if (!context) return null
    const close = closingBracketOffset(suffix)
    const from = lineStart + context.open
    const to = caret + (close < 0 ? 0 : close)
    const link = `[[${name}]]`
    return { text: text.slice(0, from) + link + text.slice(to), caret: from + link.length }
}
