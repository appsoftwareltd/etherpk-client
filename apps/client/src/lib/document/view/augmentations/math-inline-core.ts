/**
 * Inline Math delimiter scan (CONTEXT.md → Inline Math; ADR 0022). Line-local and pure:
 * a span is an unescaped `$`, non-empty trimmed content with no `$`, then an unescaped
 * closing `$` on the SAME line. An unclosed `$` (currency) is text; `\$` is text; an
 * empty pair (`$$`) is consumed as literal — which is what degrades `$$x$$` to plain
 * text with no backtracking. Content inside inline code spans is skipped. The host
 * additionally excludes lines inside fenced blocks (fence content is never inline math).
 */

export interface InlineMathSpan {
    /** Column of the opening `$`. */
    from: number
    /** Column just past the closing `$`. */
    to: number
    /** The TeX between the delimiters (untrimmed). */
    tex: string
}

/** Whether the character at `index` is escaped (odd number of preceding backslashes). */
function isEscaped(line: string, index: number): boolean {
    let backslashes = 0
    for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++
    return backslashes % 2 === 1
}

/** Ranges covered by inline code spans (`…`) on the line — `$` inside them is literal. */
function codeSpanRanges(line: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    let open = -1
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== '`' || isEscaped(line, i)) continue
        if (open < 0) {
            open = i
        } else {
            ranges.push([open, i + 1])
            open = -1
        }
    }
    return ranges
}

export function scanInlineMath(line: string): InlineMathSpan[] {
    const spans: InlineMathSpan[] = []
    const inCode = codeSpanRanges(line)
    const inCodeSpan = (i: number) => inCode.some(([a, b]) => i >= a && i < b)
    let i = 0
    while (i < line.length) {
        if (line[i] !== '$' || isEscaped(line, i) || inCodeSpan(i)) {
            i++
            continue
        }
        // An opener candidate: find the next unescaped `$` on the line (outside code spans).
        let close = -1
        for (let j = i + 1; j < line.length; j++) {
            if (line[j] === '$' && !isEscaped(line, j) && !inCodeSpan(j)) {
                close = j
                break
            }
        }
        if (close < 0) break // unclosed — currency; nothing further on the line can pair
        const tex = line.slice(i + 1, close)
        if (tex.trim().length > 0) spans.push({ from: i, to: close + 1, tex })
        // An empty pair is consumed as literal (no backtracking) — degrades `$$x$$` to text.
        i = close + 1
    }
    return spans
}
