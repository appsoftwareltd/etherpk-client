/**
 * The grammar for a [[Fenced Code Block]]'s info-string, from the registry the editor nests inside
 * fences (`@codemirror/language-data`, see `view/augmentations/code-highlight.ts`). Every surface
 * that highlights code outside an editor - the publisher (`publish/highlight.ts`) and the
 * read-only quotes (`code-tokens.ts`) - resolves a language here, so each knows the languages
 * the editor knows, by the same names and aliases.
 *
 * The match is exact: a language's name or one of its aliases, in any case. The editor's own
 * lookup (`@codemirror/lang-markdown`) also matches an alias found inside the info-string, which
 * reads `text`, `plaintext` and `context` as LaTeX (alias `tex`), so a plain-text block turned
 * into a LaTeX one, `%` starting a comment. That fuzzy step is not repeated here.
 */

import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

const loaded = new Map<string, Promise<LanguageSupport | null>>()

/** The grammar for an info-string, loaded once; null for a language the editor does not know either. */
export async function loadCodeLanguage(lang: string): Promise<LanguageSupport | null> {
    const key = lang.toLowerCase()
    let pending = loaded.get(key)
    if (!pending) {
        const description = LanguageDescription.matchLanguageName(languages, key, false)
        pending = description ? description.load().catch(() => null) : Promise.resolve(null)
        loaded.set(key, pending)
    }
    return pending
}
