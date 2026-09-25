/**
 * Code-region detection for wikilink suppression. Rather than hand-roll a fence
 * scanner, we use `@lezer/markdown` (the framework-agnostic parser CodeMirror's
 * lang-markdown wraps) to report the ranges of code nodes; the wikilink scanner
 * then ignores any segment overlapping one. Pure and headless — the same rule
 * serves the editor, the index, and publish (ADR 0011, docs/.../Wikilinks.md).
 */

import { parser } from '@lezer/markdown'

/** Node types whose ranges are code and must not contain wikilinks. */
const CODE_NODES = new Set([
    'FencedCode', // ``` … ``` and ~~~ … ~~~ (incl. fences)
    'CodeBlock', // indented code
    'InlineCode', // `…` (incl. backticks)
    'HTMLBlock',
    'CommentBlock',
    'Comment',
])

export interface CodeRange {
    from: number
    to: number
}

/** The code ranges in `source`, as absolute `[from, to)` offsets. */
export function codeRanges(source: string): CodeRange[] {
    const tree = parser.parse(source)
    const ranges: CodeRange[] = []
    tree.iterate({
        enter: (node) => {
            if (CODE_NODES.has(node.name)) ranges.push({ from: node.from, to: node.to })
        },
    })
    return ranges
}

/** Whether the half-open range `[from, to)` overlaps any code range. */
export function isInCode(ranges: readonly CodeRange[], from: number, to: number): boolean {
    return ranges.some((r) => from < r.to && to > r.from)
}
