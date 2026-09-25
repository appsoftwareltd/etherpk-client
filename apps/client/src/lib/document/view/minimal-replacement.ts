/**
 * The smallest single replacement turning `text` into `next`: the shared prefix and suffix
 * trimmed away. Null when the two are equal.
 *
 * Used wherever a whole new text arrives for a document that is being edited - a heal, an
 * external write reaching an open editor - so that the change is the change and nothing more
 * (ADR 0066): on a synced graph a whole-document replace is one enormous CRDT operation that
 * clobbers everyone else's concurrent edits, and in any editor it throws the caret to the end.
 */
export function minimalReplacement(
    text: string,
    next: string,
): { from: number; to: number; insert: string } | null {
    if (next === text) return null
    let prefix = 0
    while (prefix < text.length && prefix < next.length && text[prefix] === next[prefix]) prefix++
    let suffix = 0
    while (
        suffix < text.length - prefix &&
        suffix < next.length - prefix &&
        text[text.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
        suffix++
    }
    return { from: prefix, to: text.length - suffix, insert: next.slice(prefix, next.length - suffix) }
}
