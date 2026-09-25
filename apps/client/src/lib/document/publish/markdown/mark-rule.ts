/**
 * `==highlight==` → `<mark>`, the Obsidian and Logseq spelling the editor recognises
 * (ADR 0077). A port of markdown-it-mark's delimiter walk, kept here rather than added as a
 * dependency because the whole plugin is forty lines and the package ships no types.
 */

import type { MarkdownIt, StateInline } from 'markdown-it'

const EQUALS = 0x3d

function tokenize(state: StateInline, silent: boolean): boolean {
    const start = state.pos
    const marker = state.src.charCodeAt(start)
    if (silent || marker !== EQUALS) return false
    const scanned = state.scanDelims(state.pos, true)
    let len = scanned.length
    const ch = String.fromCharCode(marker)
    if (len < 2) return false
    if (len % 2) {
        // An odd run leaves one literal `=` in front.
        const token = state.push('text', '', 0)
        token.content = ch
        len--
    }
    for (let i = 0; i < len; i += 2) {
        const token = state.push('text', '', 0)
        token.content = ch + ch
        state.delimiters.push({
            marker,
            length: 0, // disables "rule of 3" length checks, as the original does
            token: state.tokens.length - 1,
            end: -1,
            open: scanned.can_open,
            close: scanned.can_close,
        })
    }
    state.pos += scanned.length
    return true
}

function postProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
    let loneMarkers: number[] = []
    for (let i = 0; i < delimiters.length; i++) {
        const startDelim = delimiters[i]
        if (startDelim.marker !== EQUALS || startDelim.end === -1) continue
        const endDelim = delimiters[startDelim.end]
        const open = state.tokens[startDelim.token]
        open.type = 'mark_open'
        open.tag = 'mark'
        open.nesting = 1
        open.markup = '=='
        open.content = ''
        const close = state.tokens[endDelim.token]
        close.type = 'mark_close'
        close.tag = 'mark'
        close.nesting = -1
        close.markup = '=='
        close.content = ''
        const next = state.tokens[endDelim.token - 1]
        if (next.type === 'text' && next.content === '=') {
            loneMarkers.push(endDelim.token - 1)
        }
    }
    // Any lone `=` left after pairing collapses into the closer before it.
    while (loneMarkers.length) {
        const i = loneMarkers.pop() as number
        let j = i + 1
        while (j < state.tokens.length && state.tokens[j].type === 'mark_close') j++
        j--
        if (i !== j) {
            const token = state.tokens[j]
            state.tokens[j] = state.tokens[i]
            state.tokens[i] = token
        }
    }
    loneMarkers = []
}

export function markRule(md: MarkdownIt): void {
    md.inline.ruler.before('emphasis', 'etherpk_mark', tokenize)
    md.inline.ruler2.before('emphasis', 'etherpk_mark', (state) => {
        postProcess(state, state.delimiters)
        const meta = state.tokens_meta
        for (let i = 0; i < meta.length; i++) {
            const m = meta[i]
            if (m?.delimiters) postProcess(state, m.delimiters)
        }
        return true
    })
}
