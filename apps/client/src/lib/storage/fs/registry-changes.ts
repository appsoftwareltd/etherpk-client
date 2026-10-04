/**
 * What a rescan of a graph folder changed, as the [[Derived Index]] needs to hear it: the
 * documents whose files changed on disk, each by name, and whether any name changed (a document
 * added, removed, retitled or re-cased, or given other aliases). The two are separate because they
 * cost differently: a changed file is one document to re-read, while moved names are reconciled
 * against the index's own names (`reconcileNames`) and re-read only the documents they touch.
 *
 * The store keeps an entry's file stamps in step with its own writes, so a save it made is never
 * reported here a second time: what is left is an edit made outside the app.
 *
 * A document new under its name, or held by another file than before, is named as well as moving
 * the names. Names alone cannot tell it from the document the index last saw under that name: a
 * page renamed away and another created under its old title, both before the index caught up,
 * left the index holding the first page's rows for the second.
 *
 * Pure, so the rule is unit-tested without a folder.
 */

import { conceptKey } from './identity'
import type { DocumentEntry } from './scan'

export interface RegistryChanges {
    namesMoved: boolean
    /** Documents to read again, by their names now: a file changed on disk, or new under its name. */
    contentChanged: string[]
}

export function registryChanges(previous: ReadonlyMap<string, DocumentEntry>, next: readonly DocumentEntry[]): RegistryChanges {
    let namesMoved = previous.size !== next.length
    const contentChanged: string[] = []
    for (const entry of next) {
        const before = previous.get(entry.key)
        if (!before) {
            namesMoved = true
            contentChanged.push(entry.concept)
            continue
        }
        if (before.concept !== entry.concept || before.kind !== entry.kind || !sameAliases(before.aliases, entry.aliases)) namesMoved = true
        const anotherFile = before.subdir !== entry.subdir || before.fileName !== entry.fileName
        if (anotherFile || before.lastModified !== entry.lastModified || before.size !== entry.size) contentChanged.push(entry.concept)
    }
    return { namesMoved, contentChanged }
}

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    const keys = new Set(a.map(conceptKey))
    return b.every((alias) => keys.has(conceptKey(alias)))
}
