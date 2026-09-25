/**
 * The one rule for what counts as [[Frontmatter]] (CONTEXT.md).
 *
 * There were three, and they disagreed. `parseFrontmatter` and `frontmatterLineOffset` closed on
 * `---` only and treated an unterminated opener as no frontmatter; the editor's analysis also
 * accepted `...`, tolerated trailing whitespace on a delimiter, and treated an unterminated
 * opener as frontmatter running to the END of the document. A file closed with `...` was
 * therefore frontmatter to the editor's completion guards and plain body to storage - its
 * `title:` never read, so the document's identity silently came from its file name instead.
 *
 * The rule, stated once:
 *
 * - A line of exactly `---` at offset 0, trailing spaces or tabs allowed.
 * - Closed by the next line of exactly `---`, same allowance. **Only** `---`: `...` is a YAML
 *   document terminator, but no tool this format meets writes it (Jekyll, Obsidian, Logseq,
 *   AS Notes), and accepting it suppressed editor completions across whole documents on the
 *   strength of a terminator nobody types.
 * - An **unterminated** opener is not Frontmatter. It is plain text until the document balances -
 *   the same rule `editor-analysis.ts` applies to a freshly typed ``` fence, and for the same
 *   reason: otherwise typing `---` restyles everything below it while you are still typing.
 * - CRLF tolerated throughout.
 *
 * Pure string work, no parser and no editor: the storage parse, the editor's analysis and the
 * reveal offset all measure from this, so they cannot drift apart again.
 */

/** Where a document's Frontmatter sits. Offsets are into the whole document text. */
export interface FrontmatterSpan {
    /** Offset just past the closing delimiter's line terminator (or the end of the text). */
    end: number
    /** Lines the block occupies, both delimiters included — what a body-relative offset needs. */
    lines: number
    /** The YAML between the delimiters, terminators excluded. */
    body: string
    /** Offsets of {@link body} within the document. */
    bodyFrom: number
    bodyTo: number
}

/** A line that is exactly a `---` delimiter (trailing spaces and tabs allowed). */
const DELIMITER = /^---[ \t]*\r?$/

/** Whether `line` is a delimiter line: exactly `---`, trailing spaces or tabs allowed. */
export function isFrontmatterDelimiter(line: string): boolean {
    return DELIMITER.test(line)
}

/** The Frontmatter of `text`, or `null` when it has none — including an unterminated opener. */
export function frontmatterSpan(text: string): FrontmatterSpan | null {
    const firstBreak = text.indexOf('\n')
    // A document that is only `---` has no closing delimiter, so it is not Frontmatter.
    if (firstBreak === -1 || !DELIMITER.test(text.slice(0, firstBreak))) return null

    const bodyFrom = firstBreak + 1
    let lineStart = bodyFrom
    let lines = 1
    while (lineStart <= text.length) {
        const nextBreak = text.indexOf('\n', lineStart)
        const lineEnd = nextBreak === -1 ? text.length : nextBreak
        lines += 1
        if (DELIMITER.test(text.slice(lineStart, lineEnd))) {
            // The body stops before the newline that begins the closing delimiter's line - and
            // before that line's `\r` under CRLF, which belongs to the terminator, not the YAML.
            let bodyTo = Math.max(bodyFrom, lineStart - 1)
            if (bodyTo > bodyFrom && text[bodyTo - 1] === '\r') bodyTo -= 1
            return {
                end: nextBreak === -1 ? text.length : nextBreak + 1,
                lines,
                body: text.slice(bodyFrom, bodyTo),
                bodyFrom,
                bodyTo,
            }
        }
        if (nextBreak === -1) break
        lineStart = nextBreak + 1
    }
    return null // unterminated: plain text until the document balances
}

/**
 * How many lines a document's [[Frontmatter]] occupies - opener and closer included - given the
 * document already split into lines, or 0 when it has none. The same rule as {@link frontmatterSpan}
 * (a lone `---` is not a block; an unterminated one is not a block), for the line-shaped consumers
 * in the editor that treat the block as opaque: the outliner's scans, the bullet dots, the guides,
 * the clamp. Those already hold `lines`, and re-joining them per keystroke to ask the text form
 * would be the only O(n) step in an otherwise line-local pass.
 */
export function frontmatterLines(lines: readonly string[]): number {
    if (lines.length < 2 || !DELIMITER.test(lines[0])) return 0
    for (let i = 1; i < lines.length; i++) {
        if (DELIMITER.test(lines[i])) return i + 1
    }
    return 0
}
