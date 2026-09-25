/**
 * markdown-it inline rule for `[[wikilinks]]`, the publish counterpart of the editor's
 * decoration: one `<a>` per segment (chained sibling anchors, `DESIGN.md` → Publishing), built
 * from the same `parseWikilinks` + `wikilinkSegments` model, so a scoped concept renders the same
 * way here, in a heading and in a menu. Running as an inline rule rather than a pre-pass means
 * code is suppressed by markdown-it itself: a fence never reaches the inline parser and a code
 * span is consumed whole before this rule sees its `[[`.
 */

import type { MarkdownIt, StateInline } from 'markdown-it'

import { wikilinkSegments } from '../../wikilink/model'
import { parseWikilinks } from '../../wikilink/parser'
import type { ResolvedTarget } from '../../wikilink/resolver'

export type WikilinkResolve = (concept: string) => ResolvedTarget

/** Offset of the last `]` of the `]]` that closes the `[[` at `pos`, at the same depth, or -1. */
function outermostClose(src: string, pos: number, max: number): number {
    let depth = 0
    let i = pos
    while (i < max) {
        if (src.startsWith('[[', i)) {
            depth++
            i += 2
        } else if (src.startsWith(']]', i)) {
            depth--
            if (depth === 0) return i + 1
            i += 2
        } else if (src[i] === '\n') {
            return -1 // a wikilink never spans lines
        } else {
            i++
        }
    }
    return -1
}

function stripBrackets(text: string): string {
    return text.replace(/^\[+/, '').replace(/\]+$/, '')
}

export function wikilinkRule(md: MarkdownIt, resolve: WikilinkResolve): void {
    md.inline.ruler.before('link', 'etherpk_wikilink', (state: StateInline, silent: boolean): boolean => {
        const { src, pos, posMax } = state
        if (pos + 4 >= posMax || !src.startsWith('[[', pos)) return false
        const close = outermostClose(src, pos, posMax)
        if (close === -1) return false
        if (silent) return true

        const run = src.slice(pos, close + 1)
        const segments = wikilinkSegments(parseWikilinks(run))
        if (segments.length === 0) return false
        for (const seg of segments) {
            const display = stripBrackets(run.slice(seg.start, seg.end))
            if (display.length === 0) continue
            const target = resolve(seg.wikilink.concept)
            const open = state.push('link_open', 'a', 1)
            open.attrs = [
                ['href', target.href],
                ['class', target.missing ? 'wikilink-missing' : 'wikilink'],
            ]
            open.markup = '[['
            open.info = 'wikilink'
            const text = state.push('text', '', 0)
            text.content = display
            const closeToken = state.push('link_close', 'a', -1)
            closeToken.markup = ']]'
        }
        state.pos = close + 1
        return true
    })
}
