/**
 * Render wikilink segments to chained sibling anchors (DESIGN.md → Publishing).
 * Each segment becomes its own adjacent `<a>`; empty-display segments (e.g. the
 * leading `[[` of a scoped concept) are dropped; a missing/non-public target gets
 * `class="wikilink-missing"` and points at `404.html`. Pure.
 */

import type { WikilinkSegment } from './model'
import type { WikilinkResolver } from './resolver'

/** Strip leading `[` and trailing `]` runs from a segment's raw text. */
function stripBrackets(text: string): string {
    return text.replace(/^\[+/, '').replace(/\]+$/, '')
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Render the given segments (their raw text taken from `source`) as anchors. Pass
 * the segments of one document or one construct; non-link text between them is the
 * markdown renderer's concern, not this function's.
 */
export function renderWikilinkSegmentsToHtml(
    source: string,
    segments: WikilinkSegment[],
    resolve: WikilinkResolver,
): string {
    let html = ''
    for (const seg of segments) {
        const display = stripBrackets(source.slice(seg.start, seg.end))
        if (display.length === 0) continue
        const { href, missing } = resolve(seg.wikilink.concept)
        const cls = missing ? 'wikilink-missing' : 'wikilink'
        html += `<a href="${escapeHtml(href)}" class="${cls}">${escapeHtml(display)}</a>`
    }
    return html
}
