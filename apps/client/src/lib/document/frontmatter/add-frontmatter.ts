/**
 * **Add frontmatter**: laying out the keys EtherPK reads in a document's [[Frontmatter]], each with
 * a value that changes nothing, so a person can fill them in later or leave them (ADR 0108: an
 * empty value means the key is not set).
 *
 * Pure: the dialog asks {@link planAddFrontmatter} what to offer, and the workspace writes what
 * {@link withAddedFrontmatter} returns, through the editor when the document is open in one (one
 * undo step) and through the store otherwise.
 */
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { editFrontmatter, frontmatterData, frontmatterParseProblem } from './frontmatter-yaml'
import { FRONTMATTER_PROPERTIES } from './identity'

/** A key Add frontmatter can lay out. `includes` lives inside `publication:`, not beside it. */
export type AddableKey = 'title' | 'aliases' | 'public' | 'publications' | 'slug' | 'date' | 'publication'

/**
 * The keys each kind of document can use, in the order they are offered and written. A journal
 * entry is named and dated by its day, so it has no `title` or `date`, and it cannot define a
 * publication.
 */
const KEYS_FOR: Record<'page' | 'journal', readonly AddableKey[]> = {
    page: ['title', 'aliases', 'public', 'publications', 'slug', 'date', 'publication'],
    journal: ['aliases', 'public', 'publications', 'slug'],
}

/** Ticked when the dialog first opens on a device: the keys most documents use. */
export const DEFAULT_ADD_FRONTMATTER_KEYS: readonly AddableKey[] = ['title', 'aliases', 'public', 'publications']

/** Every key the dialog can offer, for validating a remembered choice. */
export const ADDABLE_KEYS: readonly AddableKey[] = KEYS_FOR.page

/** The settings a `publication:` mapping can hold, laid out empty so they can be filled in. */
const PUBLICATION_OUTLINE = ['id', 'kind', 'selection', 'url', 'home', 'theme', 'recent', 'includes'] as const

export interface AddFrontmatterChoice {
    key: AddableKey
    /** What the key does, from EtherPK's own list of the keys it reads. */
    summary: string
    /** The block already names the key (whatever its value), so there is nothing to add. */
    present: boolean
}

export type AddFrontmatterPlan =
    | { kind: 'choices'; choices: AddFrontmatterChoice[] }
    /** The block does not parse: nothing can be added until it is fixed. `line` is 0-based in the document. */
    | { kind: 'unreadable'; message: string; line: number }

function summaryOf(key: AddableKey): string {
    return FRONTMATTER_PROPERTIES.find((property) => property.key === key)?.summary ?? ''
}

/** What the dialog offers for this document. */
export function planAddFrontmatter(text: string, kind: 'page' | 'journal'): AddFrontmatterPlan {
    const span = frontmatterSpan(text)
    const data = span ? frontmatterData(span.body) : {}
    if (data === null) {
        const problem = span ? frontmatterParseProblem(span.body) : null
        // The opening `---` is line 0, so the block's own first line is line 1.
        return { kind: 'unreadable', message: problem?.message ?? 'The block does not parse.', line: 1 + (problem?.line ?? 0) }
    }
    return { kind: 'choices', choices: KEYS_FOR[kind].map((key) => ({ key, summary: summaryOf(key), present: key in data })) }
}

/**
 * Whether the action has anything to do: a key is missing, or the block does not parse and the
 * action should say so. False once every key the document can use is there.
 */
export function canAddFrontmatter(text: string, kind: 'page' | 'journal'): boolean {
    const plan = planAddFrontmatter(text, kind)
    return plan.kind === 'unreadable' || plan.choices.some((choice) => !choice.present)
}

/** What the document's identity is, for the two keys that carry it. */
export interface AddFrontmatterIdentity {
    title: string
    aliases: readonly string[]
}

/** The inert value each key is written with. */
function valueFor(key: AddableKey, identity: AddFrontmatterIdentity): unknown {
    switch (key) {
        case 'title':
            return identity.title
        case 'aliases':
            return identity.aliases.length > 0 ? [...identity.aliases] : null
        case 'public':
            // An on/off switch reads as one: `false` says what `true` would do.
            return false
        case 'publication':
            return Object.fromEntries(PUBLICATION_OUTLINE.map((setting) => [setting, null]))
        default:
            return null
    }
}

export interface AddedFrontmatter {
    text: string
    /** Offset at the end of the first value added, or null when nothing was added. */
    caret: number | null
    /** 0-based document line holding {@link caret}, or null. */
    line: number | null
}

/**
 * The text with the chosen keys added, each after the keys the block already has, in the order
 * the dialog offers them. A key the block already names is left exactly as it is. A block that
 * does not parse is never written.
 */
export function withAddedFrontmatter(text: string, keys: readonly AddableKey[], identity: AddFrontmatterIdentity): AddedFrontmatter {
    const unchanged = { text, caret: null, line: null }
    const ordered = ADDABLE_KEYS.filter((key) => keys.includes(key))
    let first: AddableKey | null = null
    const next = editFrontmatter(
        text,
        (block) => {
            for (const key of ordered) {
                if (block.has(key)) continue
                block.set(key, valueFor(key, identity))
                first ??= key
            }
        },
        { addBlock: true },
    )
    if (next === text || first === null) return unchanged
    const at = firstValueOffset(next, first)
    return at === null ? { text: next, caret: null, line: null } : { text: next, ...at }
}

/**
 * Where the caret goes for `key`: the end of its line when it holds a value or is empty, or the
 * end of its first item or setting when its value sits on the lines below (a list, a mapping).
 */
function firstValueOffset(text: string, key: string): { caret: number; line: number } | null {
    const span = frontmatterSpan(text)
    if (!span) return null
    const lines = text.slice(0, span.end).split('\n')
    let offset = 0
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (i > 0 && line.startsWith(`${key}:`)) {
            const next = lines[i + 1]
            if (line.trimEnd() === `${key}:` && next !== undefined && /^\s/.test(next)) {
                return { caret: offset + line.length + 1 + next.replace(/\r$/, '').length, line: i + 1 }
            }
            return { caret: offset + line.replace(/\r$/, '').length, line: i }
        }
        offset += line.length + 1
    }
    return null
}
