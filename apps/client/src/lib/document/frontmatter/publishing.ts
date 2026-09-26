/**
 * The publishing keys of a document's [[Frontmatter]] (ADR 0082): `public: true` is the consent
 * switch, `publications: [docs, blog]` routes. A public document with an empty list keeps the
 * key as `publications: []`: public with nowhere to go is a state worth a prompt, and the empty
 * key is that prompt to whoever edits the file by hand. Not public, the empty key is removed. Rewritten the way `withFrontmatterIdentity`
 * rewrites identity: other keys keep their values and order, the same string comes back when
 * nothing would change, and a block whose YAML does not parse is left alone rather than
 * destroyed. Read through `readMembership` in `publish/publication.ts`; this file only writes.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { isPublicationId } from '../publish/publication'

export interface PublishingPatch {
    /** True or false sets the key; null removes it; undefined leaves it alone. */
    public?: boolean | null
    /** A list sets the key (an empty list stays as `[]` only on a public document); null removes it; undefined leaves it alone. */
    publications?: readonly string[] | null
}

function parseBlock(yaml: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = parseYaml(yaml)
        if (parsed === null || parsed === undefined) return {}
        if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed as Record<string, unknown>
    } catch {
        return null
    }
}

function sameList(a: unknown, b: readonly string[]): boolean {
    return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
}

/** The text with its publishing keys rewritten. `addBlock` adds a block to a document without one. */
export function withPublishing(text: string, patch: PublishingPatch, options: { addBlock?: boolean } = {}): string {
    const publications = patch.publications === undefined || patch.publications === null ? patch.publications : [...new Set(patch.publications.filter(isPublicationId))]
    const span = frontmatterSpan(text)
    if (!span) {
        if (!options.addBlock) return text
        const data: Record<string, unknown> = {}
        if (patch.public === true || patch.public === false) data.public = patch.public
        if (publications && (publications.length > 0 || patch.public === true)) data.publications = publications
        if (Object.keys(data).length === 0) return text
        return `---\n${stringifyYaml(data)}---\n${text}`
    }
    const data = parseBlock(span.body)
    if (data === null) return text

    const next: Record<string, unknown> = {}
    let changed = false
    const wantPublic = patch.public === undefined ? data.public : patch.public
    const keepEmpty = wantPublic === true
    const wantPublications = publications === undefined ? data.publications : publications && (publications.length > 0 || keepEmpty) ? publications : null
    for (const [key, value] of Object.entries(data)) {
        if (key === 'public') {
            if (wantPublic === null || wantPublic === undefined) changed = true
            else {
                next.public = wantPublic
                if (wantPublic !== value) changed = true
            }
            continue
        }
        if (key === 'publications') {
            if (wantPublications === null || wantPublications === undefined) changed = true
            else {
                next.publications = wantPublications
                if (!sameList(value, wantPublications as string[])) changed = true
            }
            continue
        }
        next[key] = value
    }
    if (!('public' in data) && (wantPublic === true || wantPublic === false)) {
        next.public = wantPublic
        changed = true
    }
    if (!('publications' in data) && Array.isArray(wantPublications) && (wantPublications.length > 0 || keepEmpty)) {
        next.publications = wantPublications
        changed = true
    }
    if (!changed) return text
    const yaml = Object.keys(next).length === 0 ? '' : stringifyYaml(next)
    // A block emptied of every key is removed with it, the way `syncedImportText` does.
    if (yaml === '') return text.slice(span.end)
    return `---\n${yaml}---\n${text.slice(span.end)}`
}
