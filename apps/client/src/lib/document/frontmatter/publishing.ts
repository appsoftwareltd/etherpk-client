/**
 * The publishing keys of a document's [[Frontmatter]] (ADR 0082): `public: true` is the consent
 * switch, `publications: [docs, blog]` routes. A public document with an empty list keeps the
 * key as `publications: []`: public with nowhere to go is a state worth a prompt, and the empty
 * key is that prompt to whoever edits the file by hand. Not public, the empty key is removed. Rewritten the way `withFrontmatterIdentity`
 * rewrites identity: other keys keep their values and order, the same string comes back when
 * nothing would change, and a block whose YAML does not parse is left alone rather than
 * destroyed. Read through `readMembership` in `publish/publication.ts`; this file only writes.
 */

import { isPublicationId } from '../publish/publication'

import { editFrontmatter } from './frontmatter-yaml'

export interface PublishingPatch {
    /** True or false sets the key; null removes it; undefined leaves it alone. */
    public?: boolean | null
    /** A list sets the key (an empty list stays as `[]` only on a public document); null removes it; undefined leaves it alone. */
    publications?: readonly string[] | null
}

/** The text with its publishing keys rewritten. `addBlock` adds a block to a document without one. */
export function withPublishing(text: string, patch: PublishingPatch, options: { addBlock?: boolean } = {}): string {
    const publications = patch.publications === undefined || patch.publications === null ? patch.publications : [...new Set(patch.publications.filter(isPublicationId))]
    return editFrontmatter(
        text,
        (block) => {
            if (patch.public === null) block.delete('public')
            else if (patch.public !== undefined) block.set('public', patch.public)
            if (publications === undefined) return
            const keepEmpty = (patch.public === undefined ? block.get('public') : patch.public) === true
            if (publications === null || (publications.length === 0 && !keepEmpty)) block.delete('publications')
            else block.set('publications', publications)
        },
        options,
    )
}
