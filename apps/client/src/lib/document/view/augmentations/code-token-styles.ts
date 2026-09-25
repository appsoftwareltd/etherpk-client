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
