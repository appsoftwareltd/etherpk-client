/**
 * The line model a [[Formatting Scan]] reads and writes through (ADR 0109).
 *
 * Every fix a Formatting Check proposes rewrites lines where they stand: it never adds, removes
 * or moves a line. So the diff a person approves is a line-by-line comparison rather than a search
 * for matching runs, and the write is one splice per run of changed lines, which merges with
 * concurrent edits elsewhere in the document the way a Rename's splices do (ADR 0066).
 *
 * Lines are split as CommonMark and the editor split them: `\r\n`, `\r` and `\n` each end a line.
 * The ending belongs to its line, so a fix to line endings is a change to the lines it touches.
 *
 * Pure: no DOM, no CodeMirror.
 */

import type { TextSplice } from '../wikilink/rename'

/** What ends a line: `''` only for the last line of a text. */
export type LineEnding = '' | '\n' | '\r\n' | '\r'

/** One line of a text and the ending after it. */
export interface SourceLine {
    text: string
    ending: LineEnding
}

/** The text split into lines, each with its ending. A text ending in a line break has an empty last line. */
export function splitLines(text: string): SourceLine[] {
    const lines: SourceLine[] = []
    const breaks = /\r\n?|\n/g
    let start = 0
    for (let m = breaks.exec(text); m !== null; m = breaks.exec(text)) {
        lines.push({ text: text.slice(start, m.index), ending: m[0] as LineEnding })
        start = m.index + m[0].length
    }
    lines.push({ text: text.slice(start), ending: '' })
    return lines
}

/** The text the lines were split from. */
export function joinLines(lines: readonly SourceLine[]): string {
    let out = ''
    for (const line of lines) out += line.text + line.ending
    return out
}

/** Both texts split into lines, which must be as many: a fix rewrites lines in place. */
function pairLines(before: string, after: string): { was: SourceLine[]; now: SourceLine[] } {
    const was = splitLines(before)
    const now = splitLines(after)
    if (was.length !== now.length) {
        throw new Error(`A formatting fix must keep every line: ${was.length} lines became ${now.length}`)
    }
    return { was, now }
}

function sameLine(a: SourceLine, b: SourceLine): boolean {
    return a.text === b.text && a.ending === b.ending
}

/** 0-based indices of the lines that differ between two splits of equal length. */
export function changedLineIndices(was: readonly SourceLine[], now: readonly SourceLine[]): number[] {
    const changed: number[] = []
    for (let i = 0; i < was.length; i++) if (!sameLine(was[i], now[i])) changed.push(i)
    return changed
}

/**
 * The splices that turn `before` into `after`: one per run of adjacent changed lines, each covering
 * those lines' text and endings, in document order and in `before`'s offsets. Applied from the last
 * to the first, they give `after`. Throws when the two texts have different numbers of lines.
 */
export function lineSplices(before: string, after: string): TextSplice[] {
    const { was, now } = pairLines(before, after)
    const splices: TextSplice[] = []
    let offset = 0
    for (let i = 0; i < was.length; ) {
        if (sameLine(was[i], now[i])) {
            offset += was[i].text.length + was[i].ending.length
            i++
            continue
        }
        const from = offset
        let insert = ''
        while (i < was.length && !sameLine(was[i], now[i])) {
            offset += was[i].text.length + was[i].ending.length
            insert += now[i].text + now[i].ending
            i++
        }
        splices.push({ from, to: offset, insert })
    }
    return splices
}

/** A character a diff shows with a visible stand-in, because as itself it cannot be seen. */
export type Invisible = 'tab' | 'space' | 'special-space' | 'carriage-return'

/** The stand-in a diff draws for each invisible character. */
export const INVISIBLE_GLYPHS: Readonly<Record<Invisible, string>> = {
    tab: '→',
    space: '·',
    'special-space': '⍽',
    'carriage-return': '␍',
}

/** A run of a diff row: plain text, or one invisible character with its kind. */
export interface DiffSegment {
    /** Where the run starts in its line's text (the text's length for a line ending's mark). */
    at: number
    text: string
    invisible?: Invisible
}

export interface DiffRow {
    kind: 'context' | 'removed' | 'added'
    /** 0-based line number, the same in both texts. */
    line: number
    segments: DiffSegment[]
}

/** A run of changed lines with their context, as one block of a unified diff. */
export interface DiffHunk {
    /** 0-based first and last line the hunk shows. */
    first: number
    last: number
    rows: DiffRow[]
}

/**
 * A space character other than a plain space or a tab, of the kind a person cannot tell from a
 * space by looking: `\s` minus those two and U+FEFF, which is zero-width and a byte order mark
 * rather than a space.
 */
export function isSpecialSpace(ch: string): boolean {
    return ch !== ' ' && ch !== '\t' && ch !== '\u{feff}' && /^\s$/.test(ch)
}

/**
 * A changed line's segments. Tabs and special spaces are marked wherever they are, since a fix can
 * turn one into another or deliberately keep one; a plain space is marked only in the indentation,
 * where the count is the point; a carriage return ending the line is marked after its text.
 */
function markedSegments(line: SourceLine): DiffSegment[] {
    const segments: DiffSegment[] = []
    let plain = ''
    let plainAt = 0
    let at = 0
    const flush = () => {
        if (plain !== '') segments.push({ at: plainAt, text: plain })
        plain = ''
    }
    let leading = true
    for (const ch of line.text) {
        const kind: Invisible | null = ch === '\t' ? 'tab' : isSpecialSpace(ch) ? 'special-space' : leading && ch === ' ' ? 'space' : null
        if (!/^\s$/.test(ch)) leading = false
        if (kind === null) {
            if (plain === '') plainAt = at
            plain += ch
        } else {
            flush()
            segments.push({ at, text: ch, invisible: kind })
        }
        at += ch.length
    }
    flush()
    if (line.ending.startsWith('\r')) segments.push({ at: line.text.length, text: '\r', invisible: 'carriage-return' })
    return segments
}

/** A row's text as the diff draws it, each invisible character replaced by its stand-in. */
export function shownText(segments: readonly DiffSegment[]): string {
    return segments.map((s) => (s.invisible ? INVISIBLE_GLYPHS[s.invisible] : s.text)).join('')
}

/**
 * The unified diff from `before` to `after`: each changed line as a removed row followed by an added
 * row, `context` unchanged lines around each run of changes, and runs whose context would meet
 * joined into one hunk, as `git diff` joins them. Throws when the two texts have different numbers
 * of lines.
 */
export function diffHunks(before: string, after: string, context = 3): DiffHunk[] {
    const { was, now } = pairLines(before, after)
    const changed = changedLineIndices(was, now)
    const hunks: DiffHunk[] = []
    let i = 0
    while (i < changed.length) {
        // Extend the hunk while the next change is close enough for the contexts to meet.
        let j = i
        while (j + 1 < changed.length && changed[j + 1] - changed[j] - 1 <= 2 * context) j++
        const first = Math.max(0, changed[i] - context)
        const last = Math.min(was.length - 1, changed[j] + context)
        const rows: DiffRow[] = []
        for (let line = first; line <= last; line++) {
            if (sameLine(was[line], now[line])) {
                rows.push({ kind: 'context', line, segments: [{ at: 0, text: was[line].text }] })
                continue
            }
            rows.push({ kind: 'removed', line, segments: markedSegments(was[line]) })
            rows.push({ kind: 'added', line, segments: markedSegments(now[line]) })
        }
        hunks.push({ first, last, rows })
        i = j + 1
    }
    return hunks
}
