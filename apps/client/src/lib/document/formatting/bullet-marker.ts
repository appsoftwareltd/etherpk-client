/**
 * Bullets written with `*` or `+` (ADR 0109). Markdown reads them as list items, but only a `-`
 * bullet is an outliner block, so these get no dot, no children and no keys. The fix makes each
 * marker `-`, which keeps the rest of the line: `* [ ] task` becomes the task `- [ ] task`.
 *
 * The markdown parser decides what is a list item, so a thematic break (`* * *`), emphasis and a
 * `*` in code are never touched, and numbered lists are left alone. Lines the editor reads as code
 * or frontmatter are skipped even where the parser reads them otherwise.
 */

import { markdownParser } from '../inline-parts'
import { type CheckedText, fixFinding, type FormattingCheck, metadataAndCodeLines } from './finding'

/** A line that could start a `*` or `+` list item. A document with none is never parsed. */
const MAYBE_ITEM = /^[ \t>]*[*+](?:[ \t]|$)/m

/** Syntax nodes whose insides are code or metadata, never list items. */
const OPAQUE = new Set(['FencedCode', 'CodeBlock', 'Frontmatter'])

/** Offset of each line's start in `texts.join('\n')`. */
function lineStarts(texts: readonly string[]): number[] {
    const starts: number[] = []
    let at = 0
    for (const text of texts) {
        starts.push(at)
        at += text.length + 1
    }
    return starts
}

/** The 0-based line holding `offset`: the last start at or before it. */
function lineAt(starts: readonly number[], offset: number): number {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
    }
    return lo
}

function reason(markers: ReadonlySet<string>): string {
    return `bullets written with ${[...markers].sort().join(' and ')}`
}

/** Each `*` or `+` list marker outside code and frontmatter, by line: the columns of its markers. */
function markerColumns(source: CheckedText): Map<number, number[]> {
    // The parse reads the lines joined by `\n`, so its offsets map onto line texts whatever the endings.
    const joined = source.texts.join('\n')
    const found = new Map<number, number[]>()
    if (!MAYBE_ITEM.test(joined)) return found
    const skip = metadataAndCodeLines(source)
    const starts = lineStarts(source.texts)
    markdownParser.parse(joined).iterate({
        enter(node) {
            if (OPAQUE.has(node.name)) return false
            if (node.name !== 'ListMark') return
            const marker = joined[node.from]
            if (marker !== '*' && marker !== '+') return // a `-` bullet, or a numbered item's `1.`
            const line = lineAt(starts, node.from)
            if (skip[line]) return
            const columns = found.get(line) ?? []
            columns.push(node.from - starts[line])
            found.set(line, columns)
        },
    })
    return found
}

export const bulletMarker: FormattingCheck = {
    id: 'bullet-marker',
    label: 'Bullets written with * or +',
    help: 'Only bullets written with - are outline blocks, so bullets written with * or + get no dot and cannot hold child bullets.',
    find(source) {
        const columns = markerColumns(source)
        if (columns.size === 0) return null
        const markers = new Set<string>()
        const fixed = source.lines.map((line, i) => {
            const at = columns.get(i)
            if (!at) return line
            let text = line.text
            for (const column of at) {
                markers.add(text[column])
                text = `${text.slice(0, column)}-${text.slice(column + 1)}` // one character for one: later columns hold
            }
            return { text, ending: line.ending }
        })
        return fixFinding(source, fixed, () => reason(markers))
    },
}
