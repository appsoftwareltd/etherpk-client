/**
 * [[Merge]] (CONTEXT.md): combining two [[Document]]s that have come to share one
 * [[Concept]].
 *
 * Pure, and shared on purpose. It arises in three places - renaming a page onto a name
 * already taken, a cascading scope rename that lands two scoped concepts on the same name
 * (ADR 0038 §4), and later [[Import|import-into-existing]], which must reuse this rather
 * than growing a second merge.
 *
 * Nothing is discarded. Bodies are joined and [[Alias]]es union, so every name either
 * document answered to still resolves and the result is something the user can tidy rather
 * than something they must reconstruct.
 */

import { conceptKey } from './fs/identity'

export interface MergeInput {
    /** The document that survives - its frontmatter (beyond aliases) is the one kept. */
    body: string
    aliases: string[]
}

export interface MergeResult {
    body: string
    aliases: string[]
}

/**
 * Join the two documents.
 *
 * The bodies are separated by a blank line and **nothing else** - no marker saying a merge
 * happened (a deliberate choice: the result reads as one document). A blank line is not a
 * marker, it is what stops the last line of one body running into the first line of the
 * other and silently changing the markdown.
 *
 * Aliases union, deduped by [[Concept]] identity, survivor's order first.
 */
export function mergeDocuments(survivor: MergeInput, absorbed: MergeInput): MergeResult {
    const a = survivor.body.replace(/\s+$/, '')
    const b = absorbed.body.replace(/^\s+/, '')
    const body = a === '' ? b : b === '' ? a : `${a}\n\n${b}`

    const seen = new Set<string>()
    const aliases: string[] = []
    for (const alias of [...survivor.aliases, ...absorbed.aliases]) {
        const trimmed = alias.trim()
        if (trimmed === '') continue
        const key = conceptKey(trimmed)
        if (seen.has(key)) continue
        seen.add(key)
        aliases.push(trimmed)
    }

    return { body, aliases }
}
