/**
 * Markdown parser extension: `==text==` is a [[Highlight]], the [[Inline Mark]] Obsidian and
 * Logseq share (ADR 0077). `@lezer/markdown` ships no such construct, so this is its own
 * strikethrough parser with `=` in place of `~`: a two-character delimiter, the same flanking
 * rule (no whitespace inside the pair, punctuation only if whitespace or punctuation sits
 * outside), resolved by the inline delimiter machinery exactly as `~~` is. Running `after`
 * Emphasis puts it beside strikethrough in the parse order.
 *
 * Kept on the parser side, like the url autolink, so a `==` inside inline code, a fence, or a
 * link target is excluded the same way every other inline element is, and so the format
 * augmentation reads it off the tree like the marks it already styles.
 */

import type { MarkdownExtension } from '@lezer/markdown'
import { tags } from '@lezer/highlight'

/** The delimiter's node names: the span and its two `==` marks. */
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

const EQUALS = 61 /* '=' */

/** CommonMark's punctuation class, as Lezer's own delimiter parsers test it. */
const Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/

export const Highlight: MarkdownExtension = {
    defineNodes: [
        // No highlight tag: markdown-format.ts styles by node name, as it does every other mark.
        { name: 'Highlight' },
        { name: 'HighlightMark', style: tags.processingInstruction },
    ],
    parseInline: [
        {
            name: 'Highlight',
            parse(cx, next, pos) {
                if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1
                const before = cx.slice(pos - 1, pos)
                const after = cx.slice(pos + 2, pos + 3)
                const sBefore = /\s|^$/.test(before)
                const sAfter = /\s|^$/.test(after)
                const pBefore = Punctuation.test(before)
                const pAfter = Punctuation.test(after)
                return cx.addDelimiter(
                    HighlightDelim,
                    pos,
                    pos + 2,
                    !sAfter && (!pAfter || sBefore || pBefore),
                    !sBefore && (!pBefore || sAfter || pAfter),
                )
            },
            after: 'Emphasis',
        },
    ],
}
