/**
 * Turning what a user typed into an FTS5 `MATCH` expression — and turning what comes back
 * into renderable segments.
 *
 * Pure, so it unit-tests without a database.
 *
 * The governing rule: **user input never reaches the FTS parser as syntax.** FTS5 has its own
 * grammar (`"` `*` `-` `^` `:` `AND` `OR` `NOT` `NEAR`), so `C++`, `don't` and `orphan - asset`
 * would be a syntax error or, worse, a silent negation. In a live-as-you-type box a parse
 * error is not an edge case — it is the normal state halfway through typing a query. So we
 * tokenize ourselves and quote every term.
 *
 * The one syntax Search reads is its own: a [[Property Filter]] (`public:true`, ADR 0107), which
 * `parseSearchQuery` takes out of the input before the remaining words reach FTS5 the same way.
 */

/** Below this a query is not specific enough to be worth a round trip. Counts TYPED
 * characters, not tokenized ones: `C++` is three characters a user deliberately typed, and
 * telling them it is too short would be nonsense. */
export const MIN_TEXT_QUERY_LENGTH = 2

/**
 * A final term shorter than this is matched EXACTLY rather than as a prefix.
 *
 * This, not the length gate, is what stops a query matching most of the graph: `c*` matches
 * every word beginning with c, while `c` matches only a standalone `c` token — which is
 * exactly what someone searching `C++` meant.
 */
const MIN_PREFIX_LENGTH = 2

/**
 * Characters FTS5's `snippet()` wraps matches in. Control characters, because they cannot
 * occur in markdown anyone types — a printable sentinel could appear in a note and would then
 * be rendered as a highlight that is not one.
 */
export const MATCH_OPEN = '\u0002'
export const MATCH_CLOSE = '\u0003'

/** One run of snippet text, flagged as matched or not. Rendered as a text node or a `<mark>`. */
export interface SearchSegment {
    text: string
    match: boolean
}

interface ParsedTerm {
    text: string
    /** A `"quoted phrase"` is taken literally and never gets a prefix `*`. */
    phrase: boolean
}

/**
 * Split input into terms: `"quoted phrases"` survive whole, everything else is words, and all
 * punctuation is discarded. An unclosed quote is treated as if closed at the end, so a query
 * stays valid while the user is still typing it.
 */
export function parseSearchTerms(input: string): ParsedTerm[] {
    const terms: ParsedTerm[] = []
    let index = 0
    while (index < input.length) {
        const char = input[index]
        if (char === '"') {
            const end = input.indexOf('"', index + 1)
            const raw = end === -1 ? input.slice(index + 1) : input.slice(index + 1, end)
            const words = wordsIn(raw)
            if (words.length > 0) terms.push({ text: words.join(' '), phrase: true })
            index = end === -1 ? input.length : end + 1
            continue
        }
        // A run up to the next quote, tokenized into words.
        const nextQuote = input.indexOf('"', index)
        const chunk = nextQuote === -1 ? input.slice(index) : input.slice(index, nextQuote)
        for (const word of wordsIn(chunk)) terms.push({ text: word, phrase: false })
        index = nextQuote === -1 ? input.length : nextQuote
    }
    return terms
}

/**
 * The words in a run of text, as `unicode61` would tokenize them: letters and digits, with
 * everything else acting as a separator. Keeping this in step with the tokenizer is what makes
 * `[[Physics]]` findable by typing `physics` — the brackets are separators on both sides.
 */
function wordsIn(text: string): string[] {
    return text.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The `MATCH` expression for `input`, or `null` when there is nothing to search for.
 *
 * Terms are ANDed (FTS5's default), each one quoted so its content can never be read as
 * syntax. The LAST term gets a prefix `*` unless it was a quoted phrase, which is what makes
 * results narrow as you type: `orph` finds *orphaned* before you have finished the word.
 */
export function buildFtsMatch(input: string): string | null {
    const terms = parseSearchTerms(input)
    if (terms.length === 0) return null
    return terms
        .map((term, i) => {
            const quoted = `"${term.text.replace(/"/g, '""')}"`
            const isLast = i === terms.length - 1
            const prefixable = !term.phrase && term.text.length >= MIN_PREFIX_LENGTH
            return isLast && prefixable ? `${quoted}*` : quoted
        })
        .join(' ')
}

/** True when a query is worth sending to the text index at all. */
export function isSearchableTextQuery(input: string): boolean {
    if (parseSearchTerms(input).length === 0) return false
    return input.trim().length >= MIN_TEXT_QUERY_LENGTH
}

/**
 * Split a `snippet()` result on its sentinels into renderable segments.
 *
 * Returned as data, never as HTML: the text is the user's own notes, and this is the one
 * place in Search where an injection would land.
 */
export function snippetSegments(snippet: string): SearchSegment[] {
    const segments: SearchSegment[] = []
    let rest = snippet
    while (rest.length > 0) {
        const open = rest.indexOf(MATCH_OPEN)
        if (open === -1) {
            segments.push({ text: rest, match: false })
            break
        }
        if (open > 0) segments.push({ text: rest.slice(0, open), match: false })
        const close = rest.indexOf(MATCH_CLOSE, open + 1)
        if (close === -1) {
            // Unbalanced (a truncated snippet): keep the remainder as plain text rather than
            // dropping it — showing the words matters more than showing them highlighted.
            segments.push({ text: rest.slice(open + 1), match: false })
            break
        }
        segments.push({ text: rest.slice(open + 1, close), match: true })
        rest = rest.slice(close + 1)
    }
    return segments.filter((s) => s.text !== '')
}

// ── Property Filters (ADR 0107) ─────────────────────────────────────────────

/** One [[Property Filter]] as typed: `key:value`, `-key:value`, `key:*` or `key:prefix*`. */
export interface PropertyFilter {
    /** The key as typed: its spelling is what the chip shows. Matched ignoring case. */
    key: string
    /** The value, or null for `key:*` (the key is set, whatever its value). */
    value: string | null
    /** `key:va*`: the value starts with `value`. */
    prefix: boolean
    /** `-key:value`: the document must NOT carry it. */
    negated: boolean
}

/** A filter and where it sits in the input, so the chip for it can take it back out. */
export interface PropertyFilterTerm {
    filter: PropertyFilter
    from: number
    to: number
}

export interface ParsedSearchQuery {
    /** The input with every filter term removed: what name and text matching see. */
    words: string
    filters: PropertyFilter[]
    terms: PropertyFilterTerm[]
}

/** Letters, digits, `_`, `.` and `-`: a key a person can type, dot paths included. */
export const PROPERTY_KEY_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u

/** One whitespace-separated term of the input, and where it sits. */
export interface SearchToken {
    text: string
    from: number
    to: number
}

/**
 * Whitespace-separated tokens. A quote opens a run that spaces do not end, whether it starts the
 * token (`"a phrase"`) or follows a key (`status:"in progress"`); an unclosed one runs to the end.
 */
export function searchTokens(input: string): SearchToken[] {
    const out: SearchToken[] = []
    let index = 0
    while (index < input.length) {
        if (/\s/.test(input[index])) {
            index++
            continue
        }
        const from = index
        while (index < input.length && !/\s/.test(input[index])) {
            if (input[index] === '"') {
                const close = input.indexOf('"', index + 1)
                index = close === -1 ? input.length : close + 1
                continue
            }
            index++
        }
        out.push({ text: input.slice(from, index), from, to: index })
    }
    return out
}

/**
 * The filters in `input`, and the words left for name and text matching.
 *
 * A term is a filter only when its key is one at least one searchable document carries
 * (`knownKeys`, lower-cased): anything else shaped like `x:y` stays words, which keeps a URL, a
 * time or `note:` in prose as text. A fully quoted term is always words. A known key with no
 * value yet (`status:` mid-typing) is dropped from both, so the key is never searched as a word
 * a moment before the value arrives.
 */
export function parseSearchQuery(input: string, knownKeys: ReadonlySet<string>): ParsedSearchQuery {
    const filters: PropertyFilter[] = []
    const terms: PropertyFilterTerm[] = []
    const cut: { from: number; to: number }[] = []
    if (knownKeys.size > 0) {
        for (const token of searchTokens(input)) {
            if (token.text.startsWith('"')) continue
            const colon = token.text.indexOf(':')
            if (colon <= 0) continue
            const negated = token.text.startsWith('-')
            const key = token.text.slice(negated ? 1 : 0, colon)
            if (!PROPERTY_KEY_PATTERN.test(key) || !knownKeys.has(key.toLowerCase())) continue
            const filter = filterValue(key, token.text.slice(colon + 1), negated)
            cut.push({ from: token.from, to: token.to })
            if (filter === null) continue
            filters.push(filter)
            terms.push({ filter, from: token.from, to: token.to })
        }
    }
    return { words: withoutRanges(input, cut), filters, terms }
}

/** The filter for a value as typed, or null when there is no value yet. */
function filterValue(key: string, raw: string, negated: boolean): PropertyFilter | null {
    if (raw === '*') return { key, value: null, prefix: false, negated }
    if (raw.startsWith('"')) {
        const close = raw.indexOf('"', 1)
        const value = (close === -1 ? raw.slice(1) : raw.slice(1, close)).trim()
        return value === '' ? null : { key, value, prefix: false, negated }
    }
    if (raw.length > 1 && raw.endsWith('*')) return { key, value: raw.slice(0, -1), prefix: true, negated }
    return raw === '' ? null : { key, value: raw, prefix: false, negated }
}

/** `input` with the ranges removed and the gaps they leave closed to single spaces. */
function withoutRanges(input: string, ranges: readonly { from: number; to: number }[]): string {
    if (ranges.length === 0) return input
    const parts: string[] = []
    let at = 0
    for (const range of ranges) {
        parts.push(input.slice(at, range.from))
        at = range.to
    }
    parts.push(input.slice(at))
    return parts
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(' ')
}

/** The input with one filter term taken out: what a chip's × leaves in the box. */
export function removeSearchTerm(input: string, term: Pick<PropertyFilterTerm, 'from' | 'to'>): string {
    return withoutRanges(input, [term])
}

/** The chip text for a filter: `public = true`, `not status = done`, `status is set`. */
export function describePropertyFilter(filter: PropertyFilter): string {
    if (filter.value === null) return `${filter.key} ${filter.negated ? 'is not set' : 'is set'}`
    const test = filter.prefix ? `${filter.key} starts with ${filter.value}` : `${filter.key} = ${filter.value}`
    return filter.negated ? `not ${test}` : test
}
