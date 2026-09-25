/**
 * Document-level wikilink parsing: the integration point the editor decoration,
 * the backlink index, and publish all use. Parses each line (wikilinks never span
 * lines), maps offsets to absolute document positions, and drops any segment that
 * falls inside a code range (`@lezer/markdown`). Pure.
 */

import { codeRanges, isInCode, type CodeRange } from './code-ranges'
import { type WikilinkSegment, wikilinkSegments } from './model'
import { parseWikilinks } from './parser'

/** One wikilink occurrence located in a document — what the backlink index consumes. */
export interface WikilinkOccurrence {
    /** The link's concept (outer brackets stripped; inner brackets kept for scoped concepts). */
    concept: string
    /** 0-based line the link appears on. */
    line: number
    /** The full text of that line (the backlink context). */
    lineText: string
    /** Column of the opening `[` within the line. */
    matchStart: number
    /** Column just past the closing `]` within the line (exclusive). */
    matchEnd: number
}

/**
 * Every wikilink occurrence in `source` — including links nested inside others —
 * with code-suppressed links dropped. Unlike {@link wikilinkSegmentsInSource}
 * (which merges into rendering segments), this yields one entry per `[[…]]` so the
 * backlink index can record each reference. Pure.
 */
export function wikilinkOccurrencesInSource(source: string): WikilinkOccurrence[] {
    const ranges = codeRanges(source)
    const out: WikilinkOccurrence[] = []
    const lines = source.split('\n')
    let lineStart = 0
    for (let line = 0; line < lines.length; line++) {
        const lineText = lines[line]
        for (const wl of parseWikilinks(lineText)) {
            const absStart = wl.start + lineStart
            const absEnd = wl.end + lineStart
            if (isInCode(ranges, absStart, absEnd)) continue
            out.push({
                concept: wl.concept,
                line,
                lineText,
                matchStart: wl.start,
                matchEnd: wl.end + 1, // wl.end is the inclusive trailing ']'
            })
        }
        lineStart += lineText.length + 1 // +1 for the consumed newline
    }
    return out
}

/**
 * All wikilink segments in `source`, in absolute offsets, with links inside code
 * (fences / inline code) suppressed. Segments are returned in ascending start order.
 */
export function wikilinkSegmentsInSource(
    source: string,
    ranges: readonly CodeRange[] = codeRanges(source),
): WikilinkSegment[] {
    const out: WikilinkSegment[] = []
    let lineStart = 0
    for (const line of source.split('\n')) {
        for (const seg of wikilinkSegments(parseWikilinks(line))) {
            const start = seg.start + lineStart
            const end = seg.end + lineStart
            if (isInCode(ranges, start, end)) continue
            const wl = seg.wikilink
            out.push({
                start,
                end,
                wikilink: { ...wl, start: wl.start + lineStart, end: wl.end + lineStart },
            })
        }
        lineStart += line.length + 1 // +1 for the consumed newline
    }
    return out
}
