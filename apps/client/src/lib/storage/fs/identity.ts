/**
 * Concept identity, as fixed by CONTEXT.md → Concept / Alias / Slug:
 *
 * - A page's canonical concept name is its frontmatter `title`; the filename is a
 *   derived convenience (and the fallback when `title` is absent). This is why a
 *   filesystem-mangled name never corrupts identity (DESIGN.md → On-disk layout).
 * - Identity is **case-insensitive** (`conceptKey`), display is **case-preserving**.
 * - A journal entry is identified by its ISO date (its filename stem).
 *
 * Pure; no DOM, no I/O.
 */

import type { Subdir } from './directory-adapter'

export type DocumentKind = 'journal' | 'page'

/** The kind a content subdir holds, or `null` for non-document subdirs. */
export function documentKindOf(subdir: Subdir): DocumentKind | null {
    if (subdir === 'journals') return 'journal'
    if (subdir === 'pages') return 'page'
    return null
}

/** Strip a single trailing `.md` extension. */
export function fileStem(fileName: string): string {
    return fileName.replace(/\.md$/i, '')
}

/** The case-insensitive identity key for a concept (display casing is preserved elsewhere). */
export function conceptKey(concept: string): string {
    return concept.toLowerCase()
}

/** The display concept name for a page: frontmatter `title` if a non-empty string, else the filename stem. */
export function conceptOf(fm: { data: Record<string, unknown> }, fileNameStem: string): string {
    const title = fm.data.title
    if (typeof title === 'string' && title.trim() !== '') return title
    return fileNameStem
}

/** The concept (ISO date) of a journal entry, derived from its filename. */
export function journalConceptOf(fileName: string): string {
    return fileStem(fileName)
}

/** The aliases declared in frontmatter (`aliases:`), as a string array; `[]` when absent/invalid. */
export function aliasesOf(fm: { data: Record<string, unknown> }): string[] {
    const aliases = fm.data.aliases
    if (!Array.isArray(aliases)) return []
    return aliases.filter((a): a is string => typeof a === 'string')
}
