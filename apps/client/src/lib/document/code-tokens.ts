/**
 * A [[Fenced Code Block]]'s code as the editor colours it, for a surface that shows code without
 * an editor: the references [[View]]'s quoted blocks (`view/QuotedCode.svelte`).
 *
 * The grammar is the one the editor nests inside the fence (`code-languages.ts`), run headless,
 * and each token's colour comes from the editor's own table (`code-token-styles.ts`), so a quote
 * cannot drift from the document it quotes. Tokens are data, not markup: the component renders
 * them as text, so nothing from a document reaches the page as HTML.
 *
 * Pure over its arguments apart from the grammar cache: no DOM, no CodeMirror view.
 */

import type { TagStyle } from '@codemirror/language'
import { highlightTree, tagHighlighter } from '@lezer/highlight'

import { loadCodeLanguage } from './code-languages'
import { CODE_TOKEN_STYLES } from './view/augmentations/code-token-styles'

/** One run of code: its text, and the inline style that colours it (absent for plain text). */
export interface CodeToken {
    text: string
    style?: string
}

/** A `TagStyle`'s declarations as an inline style: `{ color, fontStyle }` → `color: …; font-style: …`. */
function inlineStyle({ tag: _tag, ...declarations }: TagStyle): string {
    return Object.entries(declarations)
        .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`)
        .join('; ')
}

const styles = CODE_TOKEN_STYLES.map(inlineStyle)

/**
 * Each rule's class is its index in the table. A token matched by two rules gets both; the later
 * one wins, as it does in the editor, whose stylesheet lists the rules in table order.
 */
const highlighter = tagHighlighter(CODE_TOKEN_STYLES.map((spec, index) => ({ tag: spec.tag, class: String(index) })))

function styleFor(classes: string): string {
    return styles[Math.max(...classes.split(' ').map(Number))]
}

/**
 * Answers already given, by language and code. The Backlinks panel receives fresh reference
 * objects on every index update (each autosave), so without this every quote would be parsed
 * again and, as a new promise, re-rendered from plain text: its colours flashing off and a text
 * selection in it lost. The same promise back is what lets the component leave its DOM alone.
 * Cleared rather than evicted one by one when full, as `inline-parts.ts` does: a panel's worth of
 * quotes refills it in one pass.
 */
const CACHE_LIMIT = 200
const cache = new Map<string, Promise<CodeToken[] | null>>()

/**
 * The code as coloured tokens, covering it exactly; null when the language is unknown or not
 * given. The same arguments return the same promise.
 */
export function codeTokens(lang: string, code: string): Promise<CodeToken[] | null> {
    const key = `${lang}\n${code}`
    const remembered = cache.get(key)
    if (remembered) return remembered
    if (cache.size >= CACHE_LIMIT) cache.clear()
    const tokens = tokenise(lang, code)
    cache.set(key, tokens)
    return tokens
}

async function tokenise(lang: string, code: string): Promise<CodeToken[] | null> {
    if (lang === '') return null
    const support = await loadCodeLanguage(lang)
    if (!support) return null
    const tree = support.language.parser.parse(code)
    const tokens: CodeToken[] = []
    let last = 0
    highlightTree(tree, highlighter, (from, to, classes) => {
        if (from > last) tokens.push({ text: code.slice(last, from) })
        tokens.push({ text: code.slice(from, to), style: styleFor(classes) })
        last = to
    })
    if (last < code.length) tokens.push({ text: code.slice(last) })
    return tokens
}
