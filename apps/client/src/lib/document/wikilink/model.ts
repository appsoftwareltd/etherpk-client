/**
 * The wikilink model: the pure data the parser yields and the segment queries the
 * editor decoration and publish renderer consume. No DOM, no CodeMirror, no storage.
 *
 * A wikilink yields only its **concept** (its identity); the on-disk file name and
 * the publish Slug are derived elsewhere (see `derive.ts`). See ADR 0011.
 */

/** One parsed wikilink (at any nesting level). Offsets are relative to the parsed string. */
export interface Wikilink {
    /** Full matched text, including the outer `[[` `]]`. */
    text: string
    /** Concept name: outer brackets stripped, inner brackets retained (scoped concepts). */
    concept: string
    /** Inclusive offset of the leading `[`. */
    start: number
    /** Inclusive offset of the trailing `]`. */
    end: number
}

/** A non-overlapping run of characters whose innermost covering wikilink is `wikilink`. */
export interface WikilinkSegment {
    /** Inclusive start offset. */
    start: number
    /** Exclusive end offset. */
    end: number
    wikilink: Wikilink
}

/** The concept for a matched `[[…]]` text: strip exactly the outer `[[` and `]]`. */
export function conceptOf(text: string): string {
    return text.slice(2, -2)
}

/**
 * The innermost (smallest) wikilink covering an offset, or undefined if none.
 * Maps a cursor/click position to the link it should act on.
 */
export function innermostWikilinkAt(links: Wikilink[], offset: number): Wikilink | undefined {
    let best: Wikilink | undefined
    for (const link of links) {
        if (offset < link.start || offset > link.end) continue
        if (!best || link.end - link.start < best.end - best.start) best = link
    }
    return best
}

/**
 * Split the covered span into non-overlapping, contiguous segments, each owned by the
 * innermost wikilink at that position. Gaps between sibling links (plain text) produce
 * no segment. End offsets are exclusive.
 */
export function wikilinkSegments(links: Wikilink[]): WikilinkSegment[] {
    if (links.length === 0) return []
    let min = Infinity
    let max = -Infinity
    for (const l of links) {
        if (l.start < min) min = l.start
        if (l.end > max) max = l.end
    }

    const segments: WikilinkSegment[] = []
    let current: WikilinkSegment | undefined
    for (let offset = min; offset <= max; offset++) {
        const inner = innermostWikilinkAt(links, offset)
        if (!inner) {
            current = undefined // a gap between siblings breaks the run
            continue
        }
        if (current && current.wikilink === inner) {
            current.end = offset + 1
        } else {
            current = { start: offset, end: offset + 1, wikilink: inner }
            segments.push(current)
        }
    }
    return segments
}
