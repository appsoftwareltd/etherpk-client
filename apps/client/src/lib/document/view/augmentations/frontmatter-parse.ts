/**
 * [[Frontmatter]] as a real node in the markdown tree, rather than something decorated over the
 * wrong one.
 *
 * Without this the parser sees no frontmatter at all, and what it makes of
 * `---\ntitle: Kanban\ntags: [a]\n---` is three separate wrongs:
 *
 * ```text
 * HorizontalRule  the opening delimiter, as a thematic break
 * SetextHeading2  the WHOLE body, as an H2 whose underline is the closing delimiter
 *   Link          `[a]`, a YAML list read as a markdown link
 *   HeaderMark    the closing delimiter
 * ```
 *
 * The reported symptom is the third: `HeaderMark` is in `markdown-format.ts`'s marker set, so the
 * closing `---` is hidden *by design* the moment the caret leaves its line. The opening one
 * survives only because a thematic break has no marker to hide. Meanwhile the metadata's values
 * are markdown - `title: *draft*` renders italic.
 *
 * Parsing it fixes all three at the root: one opaque node, so there is no marker to hide and no
 * markdown inside to render. Everything else - the panel, the dimmed delimiters, the YAML
 * colouring, the opaqueness to other augmentations - hangs off the node rather than off a rule
 * each augmentation has to remember.
 *
 * What counts as Frontmatter is `frontmatter-span.ts`'s to say, shared with the storage parse and
 * the editor's analysis. This module owns only where the nodes go.
 */

import { yaml } from '@codemirror/lang-yaml'
import { type Input, parseMixed, type SyntaxNodeRef } from '@lezer/common'
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown'
import { tags as t } from '@lezer/highlight'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

/** The whole block, delimiters included. */
export const FRONTMATTER_NODE = 'Frontmatter'
/** One `---` line. Styled like a fence's backticks: visible, dimmed. */
export const FRONTMATTER_MARK = 'FrontmatterMark'
/** The YAML between them — the region the nested grammar highlights. */
export const FRONTMATTER_CONTENT = 'FrontmatterContent'

/** A line that is exactly a `---` delimiter (trailing spaces and tabs allowed). */
const DELIMITER = /^---[ \t]*$/

/**
 * Only at offset 0. A `---` anywhere else stays what markdown says it is - a thematic break, or
 * a setext heading's underline - and this must never take one of those over.
 */
function isDocumentStart(cx: BlockContext, line: Line): boolean {
    return cx.lineStart === 0 && line.pos === 0
}

/**
 * The whole document, for deciding whether the opener is closed BEFORE a line is consumed. A block
 * parser cannot hand consumed lines back: one that walked to the end looking for a closer and then
 * declined left the entire document as one empty paragraph, so every heading, emphasis and rule
 * below an opener being typed vanished until the closer arrived.
 *
 * `@lezer/markdown` (1.6.4) marks the context's `input` internal and offers no public look-ahead
 * past one line (`peekLine`), so it is read through this one cast. If an upgrade removes it this
 * returns null, the scan below falls back to consuming, and frontmatter-parse.test.ts goes red.
 */
function documentText(cx: BlockContext): string | null {
    const input = (cx as unknown as { input?: Input }).input
    return input ? input.read(0, input.length) : null
}

export const Frontmatter: MarkdownConfig = {
    defineNodes: [
        { name: FRONTMATTER_NODE, block: true },
        { name: FRONTMATTER_MARK, style: t.processingInstruction },
        { name: FRONTMATTER_CONTENT },
    ],
    parseBlock: [
        {
            name: FRONTMATTER_NODE,
            // Ahead of everything: at offset 0 a `---` would otherwise be claimed as a thematic
            // break before this is ever consulted.
            before: 'HorizontalRule',
            parse(cx: BlockContext, line: Line): boolean {
                if (!isDocumentStart(cx, line) || !DELIMITER.test(line.text)) return false
                // An unterminated opener is not Frontmatter (the shared rule, frontmatter-span.ts):
                // decline while nothing is consumed, so the ordinary parser reads every line.
                const text = documentText(cx)
                if (text !== null && frontmatterSpan(text) === null) return false

                const from = cx.lineStart
                const openTo = from + line.text.length
                const contentFrom = openTo + 1
                let contentTo = contentFrom

                // Scan for the closing delimiter, which the check above has already found.
                // `nextLine()` advances the SAME Line object that was passed in, so reading it
                // back through the parameter is how a block parser walks (`cx.line` is private).
                while (cx.nextLine()) {
                    if (DELIMITER.test(line.text)) {
                        const closeFrom = cx.lineStart
                        const closeTo = closeFrom + line.text.length
                        const children = [cx.elt(FRONTMATTER_MARK, from, openTo)]
                        // An empty block has no content node at all, rather than a zero-width one.
                        if (contentTo > contentFrom) {
                            children.push(cx.elt(FRONTMATTER_CONTENT, contentFrom, contentTo))
                        }
                        children.push(cx.elt(FRONTMATTER_MARK, closeFrom, closeTo))
                        cx.addElement(cx.elt(FRONTMATTER_NODE, from, closeTo, children))
                        cx.nextLine()
                        return true
                    }
                    contentTo = cx.lineStart + line.text.length
                }
                return false
            },
        },
    ],
    /**
     * The body is YAML, highlighted by the real grammar — the same thing a [[Fenced Code Block]]
     * does for its info-string, so Frontmatter is not the one panel in the editor deliberately
     * left uncoloured. `@codemirror/lang-yaml` is small and synchronous; the fence's lazy
     * `codeLanguages` machinery is keyed to info-strings and does not reach a custom node.
     */
    wrap: parseMixed((node: SyntaxNodeRef) =>
        node.name === FRONTMATTER_CONTENT ? { parser: yaml().language.parser } : null,
    ),
}
