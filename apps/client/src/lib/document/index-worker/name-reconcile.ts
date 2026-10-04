/**
 * Which documents' names differ between the [[Derived Index]] and the store, so a change to the
 * graph's names (a create, a rename, an alias change, a delete) re-reads only those documents
 * rather than every document in the graph.
 *
 * Both sides are documents by their names, without their text: the index's are its own page and
 * alias rows (the worker's \`names\` answer), the store's its listing. A document whose title, kind
 * or aliases differ is \`changed\` and read again; a title the index has and the store does not is
 * \`removed\`. Matched by title key, so a page whose title another page has as an alias is still a
 * document of its own. A name only links hold (a [[Pageless Concept]]) has no page row, so it is
 * never removed here: the linking documents keep it.
 *
 * Pure, so the rule is unit-tested without a worker or a store.
 */

import { conceptKey } from '../backlinks/backlink-index'
import type { NamedDocument } from '../backlinks/live-index'

export interface NameReconciliation {
    /** Documents to read again, by their titles now. */
    changed: string[]
    /** Titles the index holds that no document has any more. */
    removed: string[]
}

export function reconcileNames(indexed: readonly NamedDocument[], listed: readonly NamedDocument[]): NameReconciliation {
    const held = new Map(indexed.map((document) => [conceptKey(document.concept), document]))
    const changed: string[] = []
    for (const document of listed) {
        const key = conceptKey(document.concept)
        const known = held.get(key)
        held.delete(key)
        if (!known || known.concept !== document.concept || known.kind !== document.kind || !sameNames(known.aliases ?? [], document.aliases ?? [])) {
            changed.push(document.concept)
        }
    }
    return { changed, removed: [...held.values()].map((document) => document.concept) }
}

/** Whether two alias lists name the same names, as the index keys them: order and case aside. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
    const keys = new Set(a.map(conceptKey))
    const other = new Set(b.map(conceptKey))
    if (keys.size !== other.size) return false
    for (const key of keys) if (!other.has(key)) return false
    return true
}
