/**
 * [[Duplicate Name]]s (ADR 0157): names that more than one document in a Server-backed graph
 * answers to. Two devices that had not yet received each other's registry entry each created a
 * document for the name, and the registry kept both. The name opens only one of them, so the text
 * in the others is out of sight until a [[Merge]] joins them.
 *
 * Pure: the scan over the registry's identities, and the text a Merge writes, which the
 * Maintenance preview shows before the person confirms it.
 */

import { conceptKey } from '../fs/identity'
import { frontmatterSpan } from '../fs/frontmatter-span'
import type { DocumentIdentity } from './server-document-store'

export interface DuplicateName {
    /** The name, as the first of its documents spells it. */
    concept: string
    kind: DocumentIdentity['kind']
    /** Two or more, in registry order. */
    documents: DocumentIdentity[]
}

/**
 * Every name that more than one document answers to. Names that differ only in case are one name,
 * because a link or a search opens one document for both. Journal days come first, newest first,
 * then pages by name, as the document list orders them.
 */
export function findDuplicateNames(identities: readonly DocumentIdentity[]): DuplicateName[] {
    const byKey = new Map<string, DocumentIdentity[]>()
    for (const identity of identities) {
        const key = conceptKey(identity.concept)
        const group = byKey.get(key)
        if (group) group.push(identity)
        else byKey.set(key, [identity])
    }
    const found: DuplicateName[] = []
    for (const documents of byKey.values()) {
        if (documents.length < 2) continue
        found.push({ concept: documents[0].concept, kind: documents[0].kind, documents })
    }
    const journals = found.filter((name) => name.kind === 'journal').sort((a, b) => b.concept.localeCompare(a.concept))
    const pages = found.filter((name) => name.kind === 'page').sort((a, b) => a.concept.localeCompare(b.concept))
    return [...journals, ...pages]
}

/** A document's text below its [[Frontmatter]] block, if it has one. */
function bodyOf(text: string): string {
    return text.slice(frontmatterSpan(text)?.end ?? 0)
}

/**
 * The text a Merge leaves in the first document: its own text whole, then each other document's
 * text below its block, after a blank line, in the order given. Every other document's identity is
 * already the first one's, and its aliases join in the registry, so its block adds nothing.
 *
 * Always the first text followed by an addition, so the store writes it as an append: an edit made
 * meanwhile on another device anywhere in the first document is kept.
 */
export function mergedText(texts: readonly string[]): string {
    let merged = texts[0] ?? ''
    for (const other of texts.slice(1)) {
        const body = bodyOf(other).replace(/^\s+/, '')
        if (body === '') continue
        if (merged.trim() === '') {
            merged += body
            continue
        }
        const separator = merged.endsWith('\n\n') ? '' : merged.endsWith('\n') ? '\n' : '\n\n'
        merged += separator + body
    }
    return merged
}

export interface TextSummary {
    lines: number
    /** The first line below any block with something other than spaces on it. */
    firstLine: string
}

/** What the Maintenance list shows of each document, so the person can tell them apart. */
export function textSummary(text: string): TextSummary {
    if (text === '') return { lines: 0, firstLine: '' }
    const lines = text.split('\n')
    const count = text.endsWith('\n') ? lines.length - 1 : lines.length
    const firstLine = bodyOf(text).split('\n').find((line) => line.trim() !== '') ?? ''
    return { lines: count, firstLine: firstLine.trim() }
}

/** The default order of a Merge: the document with the most text first, so the least moves. */
export function longestFirst(docIds: readonly string[], texts: ReadonlyMap<string, string>): string[] {
    return [...docIds].sort((a, b) => (texts.get(b)?.length ?? 0) - (texts.get(a)?.length ?? 0))
}
