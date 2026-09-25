/**
 * The open graph's [[Graph Dictionary]] (CONTEXT.md; ADR 0095): the words it accepts as spelt
 * correctly beyond its Spelling Languages' dictionaries.
 *
 * **Shared graph content in its own container**, as Quick Notes are (ADR 0078), and for the same
 * reason: a field of [[Graph Settings]] is written whole into one key, so two devices adding
 * words while one is offline would keep one side's list. A `Y.Map` of word to `true` in the root
 * document of a [[Server Backend]] graph merges concurrent adds; on a [[Filesystem Backend]] the
 * list is `etherpk/dictionary.txt`, one word per line and sorted, so two people adding different
 * words merge line by line under git. The workspace wires the `persist` for whichever backend it
 * opened.
 *
 * **Set semantics.** A word is stored as written, once. Case follows Hunspell's rules when the
 * words are handed to the checker (`kubernetes` accepts `Kubernetes`; `Sidney` does not accept
 * `sidney`), so the dictionary itself compares exactly.
 */

import { spellingForm } from './words'

export interface GraphDictionaryPersist {
    add(word: string): Promise<void>
    remove(words: readonly string[]): Promise<void>
}

/** A ceiling, so a corrupt or hostile list cannot swamp the root document every device loads. */
export const MAX_DICTIONARY_WORDS = 50_000

/** Longer than any real word; a line this long is not one. */
const MAX_WORD_LENGTH = 100

/**
 * The word as the dictionary keeps it, or null when it cannot be one entry. A curly apostrophe is
 * straightened, the form the checker compares (`spelling/words.ts` → `spellingForm`), so a word
 * added from `don’t` also accepts `don't`.
 */
export function normaliseDictionaryWord(raw: string): string | null {
    const word = spellingForm(raw.trim().normalize('NFC'))
    if (word === '' || /\s/u.test(word) || word.length > MAX_WORD_LENGTH) return null
    return word
}

/** Well-formed words, deduped (first seen wins), capped: tolerant of a peer's or a newer client's list. */
export function sanitizeDictionaryWords(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    for (const entry of raw) {
        if (typeof entry !== 'string') continue
        const word = normaliseDictionaryWord(entry)
        if (word === null || seen.has(word)) continue
        seen.add(word)
        if (seen.size >= MAX_DICTIONARY_WORDS) break
    }
    return [...seen]
}

/** `existing` plus every `incoming` word it lacks: the [[Import]] merge. */
export function unionDictionary(existing: readonly string[], incoming: readonly string[]): string[] {
    return sanitizeDictionaryWords([...existing, ...incoming])
}

/** Code-unit order: the same on every device and locale, so the file never reorders itself. */
function sortedWords(words: Iterable<string>): string[] {
    return [...words].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** `etherpk/dictionary.txt`: one word per line, sorted, a final newline; empty for no words. */
export function dictionaryFileText(words: Iterable<string>): string {
    const lines = sortedWords(words)
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** The words of a dictionary file; blank lines and anything that is not one word are skipped. */
export function parseDictionaryFile(text: string): string[] {
    return sanitizeDictionaryWords(text.split(/\r?\n/))
}

let words = new Set<string>()
let persist: GraphDictionaryPersist | null = null
const listeners = new Set<(words: ReadonlySet<string>) => void>()

function emit(): void {
    for (const listener of listeners) listener(words)
}

/** Adopt the open graph's dictionary and the way to save it. Called on graph open (and close, with none). */
export function setGraphDictionary(initial: readonly string[], persistFn: GraphDictionaryPersist | null): void {
    words = new Set(sanitizeDictionaryWords(initial))
    persist = persistFn
    emit()
}

/** Adopt a list that arrived from elsewhere (a peer, an edit on disk) without saving it again. */
export function adoptGraphDictionary(next: readonly string[]): void {
    const incoming = sanitizeDictionaryWords(next)
    if (incoming.length === words.size && incoming.every((w) => words.has(w))) return
    words = new Set(incoming)
    emit()
}

/** The words, in insertion order. */
export function getGraphDictionary(): ReadonlySet<string> {
    return words
}

/** Subscribe to changes; fires immediately with the current words. Returns an unsubscribe. */
export function subscribeGraphDictionary(listener: (words: ReadonlySet<string>) => void): () => void {
    listeners.add(listener)
    listener(words)
    return () => void listeners.delete(listener)
}

/**
 * Add a word: true when the dictionary now holds it, false when it cannot be an entry or the
 * dictionary is full. Optimistic; a failed save puts the list back and rethrows.
 */
export async function addDictionaryWord(raw: string): Promise<boolean> {
    const word = normaliseDictionaryWord(raw)
    if (word === null) return false
    if (words.has(word)) return true
    if (words.size >= MAX_DICTIONARY_WORDS) return false
    const previous = words
    words = new Set([...words, word])
    emit()
    try {
        await persist?.add(word)
    } catch (err) {
        words = previous
        emit()
        throw err
    }
    return true
}

/** Remove words by value. Words it does not hold are ignored; a removal that changes nothing writes nothing. */
export async function removeDictionaryWords(remove: readonly string[]): Promise<void> {
    const removing = remove.filter((w) => words.has(w))
    if (removing.length === 0) return
    const previous = words
    const gone = new Set(removing)
    words = new Set([...words].filter((w) => !gone.has(w)))
    emit()
    try {
        await persist?.remove(removing)
    } catch (err) {
        words = previous
        emit()
        throw err
    }
}
