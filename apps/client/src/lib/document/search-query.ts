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
 * tokenize ourselves and quote every term. No operator syntax is exposed, ever; structured
 * querying has a home already in [[Query]].
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
