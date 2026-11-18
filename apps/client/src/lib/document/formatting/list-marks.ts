/**
 * The markers the markdown parser finds in a document, by line, for the checks that rewrite bullet
 * markers (`bullet-marker.ts`, `empty-bullet.ts`). The parser decides what is a list item, so a
 * thematic break, emphasis and a marker in code are never taken for one. Lines the editor reads as
 * code or frontmatter are skipped even where the parser reads them otherwise (ADR 0109).
 */

import type { SyntaxNodeRef } from '@lezer/common'

import { markdownParser } from '../inline-parts'
import { type CheckedText, metadataAndCodeLines } from './finding'

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

/** A marker node as `accept` sees it: the node, its line's text, and where on the line it starts and ends. */
export interface MarkNode {
    node: SyntaxNodeRef
    text: string
    from: number
    to: number
}

/**
 * The columns of each node named in `names` that `accept` takes, by line, outside code and
 * frontmatter. `maybe` is tested against the lines joined by `\n` first, so a document that cannot
 * hold such a marker is never parsed.
 */
export function markColumns(source: CheckedText, maybe: RegExp, names: ReadonlySet<string>, accept: (mark: MarkNode) => boolean): Map<number, number[]> {
    // The parse reads the lines joined by `\n`, so its offsets map onto line texts whatever the endings.
    const joined = source.texts.join('\n')
    const found = new Map<number, number[]>()
    if (!maybe.test(joined)) return found
    const skip = metadataAndCodeLines(source)
    const starts = lineStarts(source.texts)
    markdownParser.parse(joined).iterate({
        enter(node) {
            if (OPAQUE.has(node.name)) return false
            if (!names.has(node.name)) return
            const line = lineAt(starts, node.from)
            if (skip[line]) return
            const column = node.from - starts[line]
            if (!accept({ node, text: source.texts[line], from: column, to: node.to - starts[line] })) return
            const columns = found.get(line) ?? []
            columns.push(column)
            found.set(line, columns)
        },
    })
    return found
}
