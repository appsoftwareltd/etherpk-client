/**
 * Which tokens of a line [[Spell Check]] looks at: words, as the browser's `Intl.Segmenter`
 * finds them, less the ones that in notes are names, codes and identifiers far more often than
 * typos. Pure; the editor decides which text reaches it (`spell-check-core.ts` removes code,
 * links, tags and the rest first).
 */

export interface WordRange {
    /** Offset of the word's first character in the text it was found in. */
    from: number
    /** Offset just past its last character. */
    to: number
    word: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/**
 * The words in `text` worth checking. A hyphenated word comes back part by part, which is how
 * the segmenter splits it and how Hunspell checks it best.
 */
export function checkableWords(text: string): WordRange[] {
    const out: WordRange[] = []
    for (const segment of segmenter.segment(text)) {
        if (!segment.isWordLike) continue
        const from = segment.index
        const word = segment.segment
        if (text[from - 1] === '#') continue // a hashtag is a tag, not a word
        if (!isCheckable(word)) continue
        out.push({ from, to: from + word.length, word })
    }
    return out
}

/**
 * Whether a word is one Spell Check should judge. Not: a single letter; anything with a digit,
 * an underscore or a dot (`v2`, `snake_case`, `e.g`); a word in capitals (`PKMS`); a word with a
 * capital after its first letter (`EtherPK`, `iPhone`, `camelCase`).
 */
function isCheckable(word: string): boolean {
    const letters = [...word]
    if (letters.length < 2) return false
    if (/[\p{N}_.]/u.test(word)) return false
    if (word === word.toUpperCase() && word !== word.toLowerCase()) return false
    if (letters.slice(1).some((ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase())) return false
    return true
}

/**
 * The spelling a dictionary is asked about: a curly apostrophe (`’`), which keyboards and
 * pastes produce, straightened, since Hunspell dictionaries spell contractions with `'`.
 */
export function spellingForm(word: string): string {
    return word.replace(/’/g, "'")
}
