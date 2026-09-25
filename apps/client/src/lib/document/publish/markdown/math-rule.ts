/**
 * Inline maths, `$…$` on one line, with the editor's own rule (`math-inline-core.ts`): an
 * unescaped `$`, non-empty content with no `$` in it, an unescaped closing `$` on the same
 * line; an empty pair is literal; `\$` is text. Rendered by KaTeX at publish time, so the site
 * needs its stylesheet and fonts and no script.
 */

import katex from 'katex'
import type { MarkdownIt, StateInline } from 'markdown-it'

const DOLLAR = 0x24

function isEscaped(src: string, index: number): boolean {
    let backslashes = 0
    for (let i = index - 1; i >= 0 && src[i] === '\\'; i--) backslashes++
    return backslashes % 2 === 1
}

export function renderMath(tex: string, displayMode: boolean): string {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'htmlAndMathml' })
}

export function mathRule(md: MarkdownIt): void {
    md.inline.ruler.before('escape', 'etherpk_math', (state: StateInline, silent: boolean): boolean => {
        const { src, pos, posMax } = state
        if (src.charCodeAt(pos) !== DOLLAR || isEscaped(src, pos)) return false
        let end = -1
        for (let i = pos + 1; i < posMax; i++) {
            const c = src[i]
            if (c === '\n') return false
            if (c === '$' && !isEscaped(src, i)) {
                end = i
                break
            }
        }
        if (end === -1) return false
        const tex = src.slice(pos + 1, end)
        if (tex.trim() === '') return false // `$$` is literal, as in the editor
        if (silent) return true
        const token = state.push('html_inline', '', 0)
        token.content = `<span class="math math-inline">${renderMath(tex, false)}</span>`
        state.pos = end + 1
        return true
    })
}
