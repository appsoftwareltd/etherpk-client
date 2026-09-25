/**
 * The checking itself: one Hunspell instance per loaded [[Spelling Languages]] entry, plus the
 * [[Graph Dictionary]]'s words added to each. Runs in the spelling worker; takes its Hunspell
 * factory as a parameter so the same code runs under Node in the tests, over the real WASM build.
 *
 * A word is correct when ANY loaded language accepts it, the model Zettlr uses for writers who
 * mix languages in one document. The Graph Dictionary's words are added to every instance
 * (`Hunspell_add`), so they follow Hunspell's own case rules rather than an exact comparison:
 * `sidney` in the dictionary accepts `Sidney` at the start of a sentence.
 */

import { spellingForm } from './words'

/** The part of hunspell-wasm's `Hunspell` the engine uses. */
export interface HunspellLike {
    testSpelling(word: string): boolean
    getSpellingSuggestions(word: string): string[]
    addWord(word: string): void
    removeWord(word: string): void
    dispose(): void
}

export type HunspellFactory = (aff: string, dic: string) => Promise<HunspellLike>

/**
 * The writing systems a dictionary can be in. A word whose script no loaded dictionary covers is
 * left unjudged, as the browsers' own checkers do: with only English loaded, Chinese, Thai or
 * Russian text is not a run of English misspellings.
 */
const SCRIPTS = [
    'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana',
    'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada',
    'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Mongolian', 'Ethiopic',
    'Cherokee', 'Hangul', 'Hiragana', 'Katakana', 'Han',
].map((name) => ({ name, pattern: new RegExp(`\\p{Script=${name}}`, 'u') }))

/** The script of a word's first letter that has one, or null. */
function scriptOf(word: string): string | null {
    for (const ch of word) {
        const script = SCRIPTS.find((s) => s.pattern.test(ch))
        if (script) return script.name
    }
    return null
}

/** How many of a dictionary's words to read for its scripts: enough to see every alphabet it uses. */
const SCRIPT_SAMPLE = 2000

/** The scripts a `.dic` file's words are written in (its first line is a word count). */
function scriptsOfDictionary(dic: string): Set<string> {
    const scripts = new Set<string>()
    const lines = dic.split('\n', SCRIPT_SAMPLE + 1)
    for (let i = 1; i < lines.length; i++) {
        const script = scriptOf(lines[i])
        if (script) scripts.add(script)
    }
    return scripts
}

export class SpellEngine {
    private readonly instances = new Map<string, HunspellLike>()
    /** The scripts each loaded language's words are written in. */
    private readonly scripts = new Map<string, Set<string>>()
    private words = new Set<string>()

    constructor(private readonly factory: HunspellFactory) {}

    /** Load a language. Loading one already loaded does nothing. */
    async load(tag: string, aff: string, dic: string): Promise<void> {
        if (this.instances.has(tag)) return
        const instance = await this.factory(aff, dic)
        for (const word of this.words) instance.addWord(word)
        this.instances.set(tag, instance)
        this.scripts.set(tag, scriptsOfDictionary(dic))
    }

    unload(tag: string): void {
        this.instances.get(tag)?.dispose()
        this.instances.delete(tag)
        this.scripts.delete(tag)
    }

    /** The loaded languages, in load order. */
    loaded(): string[] {
        return [...this.instances.keys()]
    }

    /** Replace the Graph Dictionary's words in every loaded language. */
    setWords(next: readonly string[]): void {
        const incoming = new Set(next)
        for (const instance of this.instances.values()) {
            for (const word of this.words) if (!incoming.has(word)) instance.removeWord(word)
            for (const word of incoming) if (!this.words.has(word)) instance.addWord(word)
        }
        this.words = incoming
    }

    /**
     * One verdict per word. With no language loaded nothing is judged wrong, and neither is a
     * word in a script none of the loaded languages is written in.
     */
    check(words: readonly string[]): boolean[] {
        if (this.instances.size === 0) return words.map(() => true)
        const covered = new Set([...this.scripts.values()].flatMap((set) => [...set]))
        return words.map((word) => {
            const script = scriptOf(word)
            if (script !== null && !covered.has(script)) return true
            const form = spellingForm(word)
            for (const instance of this.instances.values()) if (instance.testSpelling(form)) return true
            return false
        })
    }

    /**
     * Up to `limit` corrections, taken in turn from each language so a German word misspelt in a
     * graph checked in English and German gets German suggestions near the top.
     */
    suggest(word: string, limit = 5): string[] {
        const form = spellingForm(word)
        const lists = [...this.instances.values()].map((instance) => instance.getSpellingSuggestions(form))
        const out: string[] = []
        for (let i = 0; out.length < limit && lists.some((list) => i < list.length); i++) {
            for (const list of lists) {
                const suggestion = list[i]
                if (suggestion !== undefined && !out.includes(suggestion) && out.length < limit) out.push(suggestion)
            }
        }
        return out
    }
}
