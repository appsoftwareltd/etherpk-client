/**
 * What [[Frontmatter]] says about a document's identity, and how to rewrite it (ADR 0061).
 *
 * Frontmatter is real text on both backends. On a [[Filesystem Backend]] it is authoritative
 * (ADR 0007); on a [[Server Backend]] the encrypted registry is, and the block is a *proposal*
 * about it. Either way exactly two properties carry identity - `title` and `aliases` - and
 * everything else in the block is kept verbatim for whatever feature defines it. This module is
 * the one place that reads those two keys out of a block and writes them back into one, so the
 * stores, the editor's proposal detection and the mirror cannot disagree about what a block
 * claims.
 *
 * Pure: no store, no editor. The YAML rules (what counts as a block, how it parses) come from
 * `storage/fs`, shared with the scan and the editor's analysis, so there is one rule.
 */
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { aliasesOf, conceptKey } from '$lib/storage/fs/identity'

import { editFrontmatter, frontmatterData } from './frontmatter-yaml'

/**
 * What an edit to a property does when the editing episode ends:
 * - `confirm`: opens a dialog before anything changes (a rename is a graph-wide operation).
 * - `silent`: applied as typed.
 * - `none`: recognised and documented, but nothing reads it yet.
 */
export type FrontmatterPolicy = 'confirm' | 'silent' | 'none'

export interface FrontmatterProperty {
    key: string
    policy: FrontmatterPolicy
    /** One line for the docs table and any UI that lists what the block can do. */
    summary: string
}

/**
 * The known properties, in the order their steps run. Silent steps come before confirmed ones,
 * so a rename cascade sees the aliases the user just wrote. A future property that needs its own
 * confirmation gets a row here and a step in `proposal.ts`; the sequencing needs no change.
 */
export const FRONTMATTER_PROPERTIES: readonly FrontmatterProperty[] = [
    {
        key: 'aliases',
        policy: 'silent',
        summary: 'Other names the document answers to. Applied when you leave the block.',
    },
    {
        key: 'title',
        policy: 'confirm',
        summary: 'The document’s name. Changing it opens the rename dialog when you leave the block.',
    },
    {
        key: 'public',
        policy: 'none',
        summary: 'Whether the document may be published at all. `public: true` is required - a protected document is never published whatever it says.',
    },
    {
        key: 'publications',
        policy: 'none',
        summary: 'The publications the document belongs to, by id: `publications: [docs, blog]`. A publication that takes every public document ignores it.',
    },
    {
        key: 'publication',
        policy: 'none',
        summary: 'Defines a publication: a mapping with an `id`, and the page\'s outline is its navigation. The page itself is never published.',
    },
    {
        key: 'includes',
        policy: 'none',
        summary: 'On a publication page: include slot → the page whose body fills it.',
    },
    {
        key: 'slug',
        policy: 'none',
        summary: 'The address the document takes on a published site (`privacy-policy` → `privacy-policy.html`) instead of one derived from its name.',
    },
    {
        key: 'date',
        policy: 'none',
        summary: 'The day a page is dated on a published blog, as `YYYY-MM-DD`. A journal entry is dated by its name.',
    },
]

export interface FrontmatterIdentity {
    /** The `title` value, or null when the block has none (or only a blank one). */
    title: string | null
    aliases: string[]
    /**
     * Whether the block names `aliases` at all. `aliases: []` and no key both read as no
     * aliases; the difference matters for a block typed during the current episode, which claims
     * nothing about aliases until it has the key (`proposeFrontmatter`).
     */
    hasAliasesKey: boolean
    /** Whether the document carries a balanced block at all. No block is no claim. */
    hasBlock: boolean
    /**
     * False when the block's YAML does not parse to a mapping: a duplicate key, or a line still
     * being typed. Such a block says nothing about identity yet, so `title` and `aliases` are
     * empty because they are unknown, not because the block claims none. True otherwise,
     * including when there is no block.
     */
    readable: boolean
}

/** What the block claims. An unterminated block is not a block, as everywhere else. */
export function frontmatterIdentity(text: string): FrontmatterIdentity {
    const span = frontmatterSpan(text)
    const data = span ? frontmatterData(span.body) : {}
    if (data === null) return { title: null, aliases: [], hasAliasesKey: false, hasBlock: true, readable: false }
    return { title: titleOf(data), aliases: aliasesOf({ data }), hasAliasesKey: 'aliases' in data, hasBlock: span !== null, readable: true }
}

function titleOf(data: Record<string, unknown>): string | null {
    const title = data.title
    return typeof title === 'string' && title.trim() !== '' ? title : null
}

/**
 * Aliases as identity sees them: trimmed, non-blank, unique case-insensitively (first spelling
 * wins), and never the document's own name - a document is not an alias of itself.
 */
export function normaliseAliases(aliases: readonly string[], concept?: string): string[] {
    const seen = new Set<string>(concept === undefined ? [] : [conceptKey(concept)])
    const out: string[] = []
    for (const raw of aliases) {
        const alias = raw.trim()
        if (alias === '') continue
        const key = conceptKey(alias)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(alias)
    }
    return out
}

/** Set equality by identity key: order and case carry no meaning. */
export function sameAliases(a: readonly string[], b: readonly string[]): boolean {
    const left = new Set(a.map(conceptKey))
    const right = new Set(b.map(conceptKey))
    return left.size === right.size && [...left].every((key) => right.has(key))
}

export interface IdentityPatch {
    /** A string sets the title; null removes it; undefined leaves it alone. */
    title?: string | null
    /** Empty removes the key; undefined leaves it alone. */
    aliases?: readonly string[]
}

export interface WriteOptions {
    /**
     * Add a block to a document that has none. Off by default: a document without a block has
     * made no claim, and a synced document grows one only to show its aliases (ADR 0061, amended
     * 2026-10-03).
     */
    addBlock?: boolean
}

/**
 * The text with its identity keys rewritten. Other keys keep their values and their order; a
 * new `title` goes first and new `aliases` last, which is how a fresh page's block reads. The
 * body is untouched. Returns the very same string when nothing would change, so callers can
 * write back on every save without reformatting a block that already agrees. A block whose YAML
 * does not parse is left alone: rewriting it would destroy whatever the user was typing.
 */
export function withFrontmatterIdentity(text: string, patch: IdentityPatch, options: WriteOptions = {}): string {
    const span = frontmatterSpan(text)
    if (span) {
        const data = frontmatterData(span.body)
        if (data === null) return text
        const wantTitle = patch.title === undefined ? titleOf(data) : patch.title
        const wantAliases = patch.aliases === undefined ? aliasesOf({ data }) : patch.aliases
        // Compared as identity: an alias list in another order or case claims the same names.
        if (wantTitle === titleOf(data) && sameAliases(wantAliases, aliasesOf({ data }))) return text
    }
    return editFrontmatter(
        text,
        (block) => {
            if (patch.title !== undefined) {
                if (patch.title === null || patch.title.trim() === '') block.delete('title')
                else block.set('title', patch.title, 'first')
            }
            if (patch.aliases !== undefined) {
                if (patch.aliases.length > 0) block.set('aliases', [...patch.aliases])
                else block.delete('aliases')
            }
        },
        options,
    )
}

/**
 * `after` - a writer's rewrite of `before` - with the document's aliases carried into the block
 * the rewrite added. A writer that gives a document its first block, as Publish does when it adds
 * `public:`, must not make the document claim fewer aliases than it has: a block with no
 * `aliases:` line claims none, and the next edit to it would clear them (ADR 0061). Only a Server
 * Backend has aliases without a block, on a document aliased before they were always shown
 * (amended 2026-10-03). On a Filesystem Backend they are read from the saved file,
 * so `aliases` is empty there provided the caller wrote pending edits before reading them
 * (`rewriteFrontmatter` flushes first). A block `before` already had is left as the writer left it.
 */
export function withAliasesInAddedBlock(before: string, after: string, aliases: readonly string[]): string {
    if (aliases.length === 0 || frontmatterSpan(before) !== null || frontmatterSpan(after) === null) return after
    return withFrontmatterIdentity(after, { aliases })
}

/**
 * The text an [[Import]] into a synced graph stores for a document whose identity it has written to
 * the registry (ADR 0061). `title` is removed: the registry names the document, and on a Server
 * Backend a block without a title claims none. `aliases` stays, so the block and the registry
 * agree and the page shows the names it answers to (an alias is never invisible, amended
 * 2026-10-03). A block with no `aliases` key reads as the claim "no aliases", so stripping them
 * would make the first edit to the block clear every imported alias. A block left with nothing to
 * show once its title goes is removed whole: no block is no claim.
 */
export function syncedImportText(text: string): string {
    const span = frontmatterSpan(text)
    if (!span) return text
    const data = frontmatterData(span.body)
    if (data === null) return text
    if (!('title' in data) && !('aliases' in data)) return text
    const identityOnly = Object.keys(data).every((key) => key === 'title' || key === 'aliases')
    if (identityOnly && aliasesOf({ data }).length === 0) return text.slice(span.end)
    // Nothing to strip: keep the block as written rather than reformatting it.
    if (!('title' in data)) return text
    return editFrontmatter(text, (block) => block.delete('title'))
}
