/**
 * Code highlighting for the site with the grammars the editor already ships: the same
 * `@codemirror/language-data` registry `code-highlight.ts` nests inside fences, resolved by
 * `code-languages.ts`, run headless over the fence's text and emitted as `<span class="tok-…">`
 * (the `classHighlighter` names), so a site knows exactly the languages the editor knows and needs
 * no script for it. A theme colours the `tok-*` classes. Unknown languages come back as null and
 * render escaped.
 */

import { classHighlighter, highlightTree } from '@lezer/highlight'

import { loadCodeLanguage } from '../code-languages'

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The fence's code as highlighted HTML (the `<code>` element's inner HTML), or null when the language is unknown. */
export async function highlightCode(lang: string, code: string): Promise<string | null> {
    if (lang === '') return null
    const support = await loadCodeLanguage(lang)
    if (!support) return null
    const tree = support.language.parser.parse(code)
    let out = ''
    let last = 0
    highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > last) out += escapeHtml(code.slice(last, from))
        out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`
        last = to
    })
    if (last < code.length) out += escapeHtml(code.slice(last))
    return out
}
