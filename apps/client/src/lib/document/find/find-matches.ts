/**
 * The [[Match]]es of a [[Find and Replace]] query in one document's source (ADR 0153).
 *
 * Find reads the markdown as written, so a wikilink's name and a mark's syntax match like any
 * other text. It never reads an [[Extension Fence]] (core never searches an extension's data, ADR
 * 0138) or the ciphertext that is a locked [[Protected Document]]'s body. Two kinds of match are
 * found but kept from a replace, each marked with why: the document's names (`title:` and
 * `aliases:` in the frontmatter, which a replace never changes) and the frontmatter's delimiter
 * lines, which the editor's boundary guard would refuse to change. A match that runs from one of
 * those regions into another is not a match at all, because no edit of it could be made whole.
 *
 * Matching is `@codemirror/search`'s query and cursors. Its panel and keymap are not used.
 * Framework-free and DOM-free, so every rule here is unit-tested against a plain `EditorState`.
 */

import { SearchQuery } from '@codemirror/search'
import { CharCategory, type EditorState, findClusterBreak, type Text } from '@codemirror/state'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { extensionFences } from '../extension-fence'
import { protectedRanges } from '../view/augmentations/protected-fence-core'

/** How a query matches: the three switches in the box. */
export interface FindOptions {
    caseSensitive: boolean
    wholeWord: boolean
    regexp: boolean
}

/** What the box holds: the text to find, what replaces it, and how it matches. */
export interface FindQuery extends FindOptions {
    search: string
    replace: string
}

/** Why a replace keeps a match's text: one of the document's names, or a frontmatter delimiter. */
export type KeptText = 'name' | 'edge'

export interface Match {
    from: number
    to: number
    /** The 1-based line the match starts on. */
    line: number
    /** Why a replace leaves this match as it is, or null when a replace changes it. */
    keep: KeptText | null
    /** A regular expression's whole match and groups, which `$&` and `$1` name in a replacement. */
    captures: readonly string[] | null
}

export interface FindResult {
    matches: Match[]
    /** Why a regular expression cannot be used, or null. */
    error: string | null
}

/**
 * The `@codemirror/search` query for the box's state. A plain query is literal, so `\n` typed
 * into it finds a backslash and an `n`. A regular expression takes `\n` as a line break, which is
 * how a match comes to cross lines.
 */
export function searchQueryFor(query: FindQuery): SearchQuery {
    return new SearchQuery({
        search: query.search,
        replace: query.replace,
        caseSensitive: query.caseSensitive,
        wholeWord: query.wholeWord,
        regexp: query.regexp,
        literal: !query.regexp,
    })
}

/**
 * Why `source` is not a usable regular expression, as the browser says it, or null. Compiled with
 * the flags `@codemirror/search` compiles it with (`gmu`), so a pattern this accepts is one the
 * cursor accepts.
 */
export function regexpError(source: string): string | null {
    try {
        new RegExp(source, 'gmu')
        return null
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}

/**
 * Whether a regular expression asks for a line break with `\n`, the one way a match may cross
 * lines (Q5). An escaped backslash before the `n` (`\\n`) is a backslash and a letter.
 */
export function asksForLineBreak(source: string): boolean {
    return /(^|[^\\])(\\\\)*\\n/.test(source)
}

/** A match as a cursor gives it: a regular expression's has its groups too. */
interface Found {
    from: number
    to: number
    match?: RegExpExecArray
}

/** Every match of `query` in the document, in document order. */
export function findMatches(state: EditorState, query: FindQuery): FindResult {
    if (query.search === '') return { matches: [], error: null }
    if (query.regexp) {
        const error = regexpError(query.search)
        if (error) return { matches: [], error }
    }
    const regions = documentRegions(state.doc)
    const matches: Match[] = []
    const found: Iterable<Found> =
        query.regexp && !asksForLineBreak(query.search)
            ? matchesByLine(state, query)
            : // The cursor's declared type leaves out the groups a regular expression's match carries.
              { [Symbol.iterator]: () => searchQueryFor(query).getCursor(state) as Iterator<Found> }
    for (const { from, to, match } of found) {
        if (regions.unread.some((range) => overlaps(range, from, to))) continue
        const keep = keptBy(regions, state.doc, from, to)
        if (keep === undefined) continue
        matches.push({ from, to, line: state.doc.lineAt(from).number, keep, captures: match ? Array.from(match, (group) => group ?? '') : null })
    }
    return { matches, error: null }
}

/**
 * A regular expression's matches one line at a time, so none crosses a line break. The cursor in
 * `@codemirror/search` reads a pattern holding `\s`, `\W`, `\D` or `[^` across lines, and `\s+`
 * replaced with a space would join a whole outline into one line. Compiled with its flags, and
 * whole words decided by its rule: the characters either side of each end of the match.
 */
function* matchesByLine(state: EditorState, query: FindQuery): Generator<Found> {
    const pattern = new RegExp(query.search, `gu${query.caseSensitive ? '' : 'i'}`)
    const categorize = state.charCategorizer(state.selection.main.head)
    const isWord = (char: string) => char !== '' && categorize(char) === CharCategory.Word
    const before = (text: string, at: number) => text.slice(findClusterBreak(text, at, false), at)
    const after = (text: string, at: number) => text.slice(at, findClusterBreak(text, at))
    for (let number = 1; number <= state.doc.lines; number++) {
        const line = state.doc.line(number)
        pattern.lastIndex = 0
        for (let match = pattern.exec(line.text); match; match = pattern.exec(line.text)) {
            const start = match.index
            const end = start + match[0].length
            // An empty match (`^`) would match again where it stands: step past it.
            if (end === start) pattern.lastIndex = findClusterBreak(line.text, end)
            if (query.wholeWord && end > start) {
                const startsWord = isWord(before(line.text, start)) && isWord(after(line.text, start))
                const endsWord = isWord(after(line.text, end)) && isWord(before(line.text, end))
                if (startsWord || endsWord) continue
            }
            yield { from: line.from + start, to: line.from + end, match }
        }
    }
}

/** One line of the [[Match List]]: its text and where on it each match falls. */
export interface MatchLine {
    /** The 1-based line number. */
    line: number
    /** The line's text. */
    text: string
    /** The index, in the full match list, of the first match on this line. */
    first: number
    /** Each match on the line, as offsets into `text`, ended at the line's end. */
    matches: { from: number; to: number }[]
    /** Why a replace keeps a match on this line, when one is kept, else null. */
    keep: KeptText | null
}

/** The most lines the Match List shows (Q22): the count and a Replace all still cover every match. */
export const MATCH_LIST_LIMIT = 1000

/** The Match List's rows, the first `limit` matching lines, and whether more were left out. */
export function matchLines(state: EditorState, matches: readonly Match[], limit = MATCH_LIST_LIMIT): { rows: MatchLine[]; truncated: boolean } {
    const rows: MatchLine[] = []
    for (const [index, match] of matches.entries()) {
        let row = rows.at(-1)
        if (!row || row.line !== match.line) {
            if (rows.length === limit) return { rows, truncated: true }
            const line = state.doc.line(match.line)
            row = { line: match.line, text: line.text, first: index, matches: [], keep: null }
            rows.push(row)
        }
        const start = state.doc.line(match.line).from
        row.matches.push({ from: match.from - start, to: Math.min(match.to - start, row.text.length) })
        row.keep ??= match.keep
    }
    return { rows, truncated: false }
}

/**
 * The match a new query makes current: the first at or after `pos`, wrapping to the first when
 * the caret is past the last. -1 with no matches.
 */
export function nearestMatch(matches: readonly { from: number }[], pos: number): number {
    if (matches.length === 0) return -1
    const index = matches.findIndex((match) => match.from >= pos)
    return index < 0 ? 0 : index
}

/** Where find does not read, and the frontmatter's regions, measured once per search. */
interface DocumentRegions {
    /** Ranges no match may touch: Extension Fences and a locked Protected Document's fence. */
    unread: { from: number; to: number }[]
    /** The frontmatter's line count, delimiters included, or 0 when the document has none. */
    frontmatterLines: number
    /** The 1-based YAML lines that hold `title:` or `aliases:`, and their values. */
    nameLines: Set<number>
}

/** The keys whose values are the document's names (ADR 0061), which a replace never changes. */
const NAME_KEYS = new Set(['title', 'aliases'])

/** A top-level YAML key at the start of a line: the line that begins a frontmatter entry. */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*)\s*:/

function documentRegions(doc: Text): DocumentRegions {
    const lines = doc.toJSON()
    const unread: { from: number; to: number }[] = []
    for (const fence of extensionFences(lines)) {
        unread.push({ from: doc.line(fence.start + 1).from, to: doc.line(fence.end + 1).to })
    }
    unread.push(...protectedRanges(doc.toString()))
    const count = frontmatterLines(lines)
    return { unread, frontmatterLines: count, nameLines: count > 0 ? nameLinesIn(lines, count) : new Set() }
}

/**
 * The YAML lines of the `title` and `aliases` entries: each key's own line and the lines below
 * it that continue its value (indented, a list item, or blank), up to the next top-level key.
 */
function nameLinesIn(lines: readonly string[], frontmatterLineCount: number): Set<number> {
    const names = new Set<number>()
    let inName = false
    // Lines 2 to count - 1 (1-based) are the YAML between the delimiters.
    for (let number = 2; number < frontmatterLineCount; number++) {
        const text = lines[number - 1]
        const key = TOP_LEVEL_KEY.exec(text)
        if (key) inName = NAME_KEYS.has(key[1])
        else if (!/^(\s|-|$)/.test(text)) inName = false
        if (inName) names.add(number)
    }
    return names
}

/** Which part of the document a line is in, for telling a match that crosses from one to another. */
type Region = 'opener' | 'yaml' | 'closer' | 'body'

function regionOf(regions: DocumentRegions, line: number): Region {
    const count = regions.frontmatterLines
    if (count === 0 || line > count) return 'body'
    if (line === 1) return 'opener'
    return line === count ? 'closer' : 'yaml'
}

/**
 * Why a replace keeps the match from `from` to `to`: null when it may change it, or `undefined`
 * when the match crosses from one region into another and is not a match at all.
 */
function keptBy(regions: DocumentRegions, doc: Text, from: number, to: number): KeptText | null | undefined {
    if (regions.frontmatterLines === 0) return null
    const first = doc.lineAt(from).number
    const last = doc.lineAt(Math.max(from, to - 1)).number
    const region = regionOf(regions, first)
    if (regionOf(regions, last) !== region) return undefined
    if (region === 'body') return null
    if (region !== 'yaml') return 'edge'
    for (let line = first; line <= last; line++) if (regions.nameLines.has(line)) return 'name'
    return null
}

/** Whether a match touches `range`. An empty match touches it when it sits inside it. */
function overlaps(range: { from: number; to: number }, from: number, to: number): boolean {
    return from === to ? from >= range.from && from < range.to : from < range.to && to > range.from
}

/** A piece of a Match List row: plain text, a match, or, with a replacement shown, the old and the new. */
export interface RowPiece {
    kind: 'text' | 'match' | 'old' | 'new'
    text: string
}

/**
 * A Match List row cut into pieces for drawing: each match marked, and where `replacements` gives
 * one (null for a match a replace keeps), the match struck through with its replacement after it.
 * A line whose first match is further in than `lead` characters starts `lead` characters before
 * it, after an ellipsis, so the match is on screen.
 */
export function rowPieces(row: MatchLine, replacements: readonly (string | null)[] | null, lead = 40): RowPiece[] {
    const pieces: RowPiece[] = []
    const start = row.matches.length > 0 && row.matches[0].from > lead ? row.matches[0].from - lead : 0
    if (start > 0) pieces.push({ kind: 'text', text: '…' })
    let at = start
    row.matches.forEach((match, index) => {
        if (match.from > at) pieces.push({ kind: 'text', text: row.text.slice(at, match.from) })
        const text = row.text.slice(match.from, match.to)
        const replacement = replacements?.[index] ?? null
        if (replacement === null) pieces.push({ kind: 'match', text })
        else pieces.push({ kind: 'old', text }, { kind: 'new', text: replacement })
        at = match.to
    })
    if (at < row.text.length) pieces.push({ kind: 'text', text: row.text.slice(at) })
    // The ellipsis joins the text after it, so a row reads as one run before its first match.
    if (start > 0 && pieces[1]?.kind === 'text') pieces.splice(0, 2, { kind: 'text', text: `…${pieces[1].text}` })
    return pieces
}
