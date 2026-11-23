/**
 * The colour of each kind of token in a [[Fenced Code Block]]: one table, read by the editor's
 * `HighlightStyle` (`code-highlight.ts`) and by the read-only quotes (`code-tokens.ts`), so code
 * reads the same in a references [[View]] as in the document it came from.
 *
 * CSS variables so the colours can track the editor theme and dark mode; the fallbacks are a
 * light-theme default. Order matters: where two rules match one token, the later one wins, in the
 * editor's stylesheet and in `code-tokens.ts` alike.
 */

import type { TagStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const CODE_TOKEN_STYLES: readonly TagStyle[] = [
    { tag: t.keyword, color: 'var(--gk-code-keyword, #0a7)' },
    { tag: [t.string, t.special(t.string)], color: 'var(--gk-code-string, #690)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--gk-code-comment, #999)', fontStyle: 'italic' },
    { tag: [t.number, t.bool, t.null], color: 'var(--gk-code-number, #905)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--gk-code-fn, #c60)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--gk-code-type, #b58900)' },
    { tag: [t.operator, t.punctuation], color: 'var(--gk-code-op, #555)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--gk-code-prop, #268bd2)' },
    { tag: t.tagName, color: 'var(--gk-code-tag, #22863a)' },
    { tag: t.invalid, color: 'var(--gk-code-invalid, #d00)' },
]

/**
 * Markdown's own tokens, for a markdown file shown as its source in the Text Editor (text-file.ts).
 * Added after the table above, which has none of them: a document draws its markdown instead.
 */
export const MARKDOWN_SOURCE_STYLES: readonly TagStyle[] = [
    { tag: t.heading, color: 'var(--gk-code-keyword, #0a7)', fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.monospace, color: 'var(--gk-code-string, #690)' },
    { tag: t.quote, color: 'var(--gk-code-comment, #999)' },
    { tag: [t.url, t.link], color: 'var(--gk-code-prop, #268bd2)' },
    // The markers: a list's dash, a heading's #, a fence's backticks.
    { tag: t.processingInstruction, color: 'var(--gk-code-op, #555)' },
]
