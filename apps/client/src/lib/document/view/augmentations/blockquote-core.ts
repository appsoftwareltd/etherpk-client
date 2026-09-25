/**
 * Which lines a markdown [[Blockquote]] covers, from the `@lezer/markdown` syntax tree (Dual Mode
 * Editor.md → Inline markdown formatting). Pure over a parsed tree, so the consumers cannot drift:
 * `markdown-format.ts` draws the quote panel over exactly these lines, `content-clamp.ts` pads their
 * text inside it, and `outline-guides.ts` runs a thread down to the panel's bottom ({@link quoteEndsAt}).
 *
 * A quote is styled like Logseq renders one — a shaded panel with a left rule, spanning every line
 * the parser places in the quote, `> ` markers hidden while the caret is away. The lines are the
 * parser's, so CommonMark's rules decide the extent: a lazy continuation line (`> a` then `b`) is
 * quoted, a blank line ends the quote, and `- > a` quotes a bullet's content. Only the OUTERMOST
 * quote of a nested `> > x` is reported: one panel covers both, and its inner `>` is just another
 * hidden marker.
 */

import type { Text } from '@codemirror/state'
import type { Tree } from '@lezer/common'

export interface QuoteLine {
    /** The quote's first line — takes the panel's top padding and corners. */
    first: boolean
    /** The quote's last line — takes the panel's bottom padding and corners. */
    last: boolean
}

/**
 * The 1-based line numbers inside a blockquote whose lines intersect `[from, to]`, each with its
 * place in the quote. Lines of a quote that straddles the range are reported only where they
 * intersect it, so a per-visible-range caller decorates each line once.
 */
export function blockquoteLines(tree: Tree, doc: Text, from = 0, to = doc.length): Map<number, QuoteLine> {
    const lines = new Map<number, QuoteLine>()
    const lower = doc.lineAt(from).number
    const upper = doc.lineAt(Math.min(to, doc.length)).number
    tree.iterate({
        from,
        to,
        enter(node) {
            if (node.name !== 'Blockquote') return
            const first = doc.lineAt(node.from).number
            const last = doc.lineAt(Math.min(node.to, doc.length)).number
            for (let n = Math.max(first, lower); n <= Math.min(last, upper); n++) {
                lines.set(n, { first: n === first, last: n === last })
            }
            return false // a nested quote is inside this panel — its `>` is hidden, not a second panel
        },
    })
    return lines
}

/**
 * Whether the 0-based line `index` is the last line of a quote: where the quote's panel ends,
 * below the text by the panel's bottom padding (the outline guides run down to there). A part of
 * the tree not yet parsed has no quote in it, so this is false there until the parse arrives.
 */
export function quoteEndsAt(tree: Tree, doc: Text, index: number): boolean {
    const line = doc.line(index + 1)
    return blockquoteLines(tree, doc, line.from, line.to).get(index + 1)?.last === true
}
