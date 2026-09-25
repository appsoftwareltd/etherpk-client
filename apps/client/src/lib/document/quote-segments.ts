/**
 * What a quoted block holds, for a surface that renders another document's text read-only (the
 * references [[View]]): its lines, as the editor draws each one off the caret's line, and the
 * block constructs the editor draws as a whole - quotes, rules, code and tables.
 *
 * - A **fence** is what the editor pairs (`fencedBlocks`), so a quote shows code where the editor
 *   shows a code panel; an unterminated opener stays text, as it does there. The fence lines are
 *   dropped (the panel is drawn instead) and the info-string becomes the language.
 * - A **table** is what the editor's grid reads (`findTables`), lifted out with its cells.
 * - Everything else is read with the editor's markdown parser, the way markdown-format.ts reads it:
 *   an ATX or setext **heading** keeps its level and loses its markers (a setext underline of one
 *   or two characters is text, the editor's `underlineReading`), a **blockquote**'s lines become
 *   one panel with their `>` markers gone (a nested quote inside the same panel, as the editor
 *   draws it), and a **thematic break** is a rule.
 *
 * Inline constructs are left in each line's text for `InlineMarkdown` to read one line at a time,
 * as the editor does (a line holding only an image is a picture).
 *
 * The pairing runs over the quoted text, which the index stores with each line's structural
 * indentation trimmed and a complete fence's lines taken whole (block-model.ts). For balanced
 * fences the result is the editor's. Fence-shaped lines that the editor could not pair, because
 * their columns disagree, lose those columns in the trim and may pair here: malformed input can
 * quote as code where the editor shows none.
 *
 * Pure over the text: no DOM, no CodeMirror.
 */

import type { SyntaxNode } from '@lezer/common'

import { codeLineText, fenceLineInfo, fencedBlocks } from './fenced-code'
import { markdownParser } from './inline-parts'
import { type Align, findTables } from './markdown-table'

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/** One line of text as a reader sees it: its heading and quote markers gone. */
export interface QuoteLine {
    text: string
    heading?: HeadingLevel
}

export type QuoteSegment =
    | ({ kind: 'line' } & QuoteLine)
    /** Consecutive quoted lines: one panel. */
    | { kind: 'quote'; lines: QuoteLine[] }
    | { kind: 'rule' }
    | { kind: 'code'; lang: string; code: string }
    | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] }

/** ATX and setext heading nodes → their level. */
const HEADING_LEVEL: Readonly<Record<string, HeadingLevel>> = {
    ATXHeading1: 1,
    ATXHeading2: 2,
    ATXHeading3: 3,
    ATXHeading4: 4,
    ATXHeading5: 5,
    ATXHeading6: 6,
    SetextHeading1: 1,
    SetextHeading2: 2,
}

/** How the parser reads one line of a text run. */
interface LineReading {
    heading?: HeadingLevel
    quote: boolean
    rule: boolean
    /** A setext heading's underline: drawn as nothing. */
    underline: boolean
    /** Marker ranges (absolute offsets into the run) hidden from the line's text. */
    hidden: [number, number][]
}

/** The end of a marker together with the whitespace after it, which markdown-format.ts hides too. */
function pastTrailingSpace(text: string, to: number): number {
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to++
    return to
}

/** Lines of prose (no fences, no tables) read into lines, quotes and rules. */
function readText(lines: readonly string[]): QuoteSegment[] {
    const text = lines.join('\n')
    const starts: number[] = []
    let offset = 0
    for (const line of lines) {
        starts.push(offset)
        offset += line.length + 1
    }
    const lineAt = (pos: number) => {
        let n = starts.length - 1
        while (n > 0 && starts[n] > pos) n--
        return n
    }
    const readings: LineReading[] = lines.map(() => ({ quote: false, rule: false, underline: false, hidden: [] }))

    markdownParser.parse(text).iterate({
        enter(node) {
            const level = HEADING_LEVEL[node.name]
            if (level !== undefined) {
                const underline = node.name.startsWith('Setext') ? node.node.getChild('HeaderMark') : null
                // An underline of one or two characters is text to the editor (markdown-format.ts,
                // `underlineReading`): an empty bullet's dash, or the first keystrokes of a rule.
                if (underline && underline.to - underline.from < 3) return false
                const last = underline ? lineAt(underline.from) - 1 : lineAt(node.to)
                for (let n = lineAt(node.from); n <= last; n++) readings[n].heading = level
                if (underline) readings[lineAt(underline.from)].underline = true
                return
            }
            if (node.name === 'Blockquote') {
                for (let n = lineAt(node.from); n <= lineAt(node.to); n++) readings[n].quote = true
                return
            }
            if (node.name === 'HorizontalRule') {
                readings[lineAt(node.from)].rule = true
                return
            }
            if (node.name === 'QuoteMark' || (node.name === 'HeaderMark' && isAtx(node.node))) {
                readings[lineAt(node.from)].hidden.push([node.from, pastTrailingSpace(text, node.to)])
            }
        },
    })

    const segments: QuoteSegment[] = []
    lines.forEach((line, n) => {
        const reading = readings[n]
        if (reading.underline) return
        if (reading.rule && !reading.quote) {
            segments.push({ kind: 'rule' })
            return
        }
        let visible = ''
        let at = starts[n]
        for (const [from, to] of reading.hidden.sort((a, b) => a[0] - b[0])) {
            visible += text.slice(at, from)
            at = Math.max(at, to)
        }
        visible += text.slice(at, starts[n] + line.length)
        const quoteLine: QuoteLine = reading.heading ? { text: visible.trimEnd(), heading: reading.heading } : { text: visible }
        const previous = segments[segments.length - 1]
        if (!reading.quote) segments.push({ kind: 'line', ...quoteLine })
        else if (previous?.kind === 'quote') previous.lines.push(quoteLine)
        else segments.push({ kind: 'quote', lines: [quoteLine] })
    })
    return segments
}

function isAtx(node: SyntaxNode): boolean {
    return node.parent?.name.startsWith('ATXHeading') === true
}

/** A run of lines with no fence in it: tables lifted out, the rest read as text. */
function readRun(lines: readonly string[]): QuoteSegment[] {
    const segments: QuoteSegment[] = []
    let next = 0
    for (const table of findTables(lines.join('\n'))) {
        if (table.startLine > next) segments.push(...readText(lines.slice(next, table.startLine)))
        segments.push({ kind: 'table', header: table.header, align: table.align, rows: table.rows })
        next = table.endLine + 1
    }
    if (next < lines.length) segments.push(...readText(lines.slice(next)))
    return segments
}

export function quoteSegments(text: string): QuoteSegment[] {
    const lines = text.split('\n')
    const segments: QuoteSegment[] = []
    let next = 0
    // In document order; a fence nested inside a longer one is its content, not a segment.
    for (const fence of [...fencedBlocks(lines)].sort((a, b) => a.start - b.start)) {
        if (fence.start < next) continue
        if (fence.start > next) segments.push(...readRun(lines.slice(next, fence.start)))
        segments.push({
            kind: 'code',
            lang: fenceLineInfo(lines[fence.start])?.info ?? '',
            code: lines
                .slice(fence.start + 1, fence.end)
                .map((line) => codeLineText(line, fence.fenceColumn))
                .join('\n'),
        })
        next = fence.end + 1
    }
    if (next < lines.length) segments.push(...readRun(lines.slice(next)))
    return segments
}

/**
 * One line as a breadcrumb shows it: its heading and quote markers gone, and nothing else read,
 * because a breadcrumb names a block rather than drawing it.
 */
export function lineText(line: string): string {
    const [first] = readText([line])
    if (first?.kind === 'line') return first.text
    if (first?.kind === 'quote') return first.lines[0].text
    return line
}
