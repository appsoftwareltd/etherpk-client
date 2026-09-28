/**
 * What completion offers inside [[Frontmatter]] (ADR 0108), and where. Pure, so the rules are
 * tested without an editor; `frontmatter-complete.ts` is the popover binding.
 *
 * - **Keys**, once a character is typed at the start of a line: EtherPK's own keys first, each
 *   with the line saying what it does, then the keys other documents in the graph use. A key the
 *   block already has is not offered. Under `publication:`, the settings a publication takes.
 * - **Values**, once a character is typed after `key: ` (or after `- ` in a list under a key):
 *   `true`/`false` for `public`, the fixed choices of `publication.kind` and `.selection`, the
 *   graph's publication ids for `publications`, and otherwise the values the key already has
 *   elsewhere in the graph.
 *
 * A character first, always: a list that opened on an empty line would take the next Enter.
 */
import { FRONTMATTER_PROPERTIES } from '$lib/document/frontmatter/identity'
import { yamlScalar } from '$lib/document/frontmatter/frontmatter-yaml'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import type { PropertyKeyInfo, PropertyValueInfo } from '../../index-db'

export type FrontmatterCompletionContext =
    | { kind: 'key'; parent: string | null; from: number; to: number; prefix: string }
    | { kind: 'value'; key: string; from: number; to: number; prefix: string }

/** The keys and settings a person can be offered, with what each does. */
const PUBLICATION_SETTINGS: Record<string, string> = {
    id: 'The publication’s id: lower-case letters, digits and hyphens, like `docs`.',
    kind: '`docs` (a site with navigation) or `blog` (posts by date).',
    selection: '`named`: documents that list this id. `all-public`: every public document.',
    url: 'The site’s address, starting with `https://`.',
    home: 'The page whose content becomes the front page.',
    theme: 'A bundled theme name, a theme url, or a graph theme id.',
    recent: 'On a blog: how many posts the front page lists (10 unless set).',
    includes: 'Include slot → the page whose body fills it.',
}

/** Values a key can only take one of. */
const CHOICES: Record<string, string[]> = {
    public: ['true', 'false'],
    'publication.kind': ['docs', 'blog'],
    'publication.selection': ['named', 'all-public'],
}

/**
 * Keys whose value names this document alone: another document's `slug` or publication `id`
 * would collide, and its title, aliases or date are its own. Nothing is offered for them.
 */
const OWN_VALUE_KEYS = new Set(['title', 'aliases', 'slug', 'date', 'publication.id', 'publication.url', 'publication.home'])

/** Whose values a key's values are drawn from, when it names something defined elsewhere. */
const VALUE_SOURCE: Record<string, string> = { publications: 'publication.id' }

/** The key whose values a key's values are drawn from: `publications` names publication ids. */
export function valueSourceOf(key: string): string {
    return VALUE_SOURCE[key] ?? key
}

/** The key of the nearest line above `index` that is indented less than `indent`, or null. */
function parentKey(lines: readonly string[], index: number, indent: number): string | null {
    for (let i = index - 1; i > 0; i--) {
        const own = /^( *)([^\s#-][^:]*):/.exec(lines[i])
        if (own && own[1].length < indent) return own[2].trim()
        if (own && own[1].length === 0) return null
    }
    return null
}

/** Where the caret is, for completion, or null when nothing should be offered. */
export function completionContext(doc: string, caret: number): FrontmatterCompletionContext | null {
    const span = frontmatterSpan(doc)
    if (!span || caret < span.bodyFrom || caret > span.bodyTo) return null
    const lines = doc.slice(0, span.end).split('\n')
    let index = 0
    let lineFrom = 0
    while (index < lines.length && lineFrom + lines[index].length < caret) {
        lineFrom += lines[index].length + 1
        index++
    }
    const line = lines[index]
    const column = caret - lineFrom
    // Only at the end of what is typed: mid-line, a list would replace text the person is keeping.
    if (line.slice(column).trim() !== '') return null
    const before = line.slice(0, column)

    const key = /^( *)([A-Za-z_][\w.-]*)$/.exec(before)
    if (key) {
        const indent = key[1].length
        const parent = indent === 0 ? null : parentKey(lines, index, indent)
        if (indent > 0 && parent !== 'publication') return null
        return { kind: 'key', parent, from: lineFrom + indent, to: caret, prefix: key[2] }
    }

    const value = /^( *)([A-Za-z_][\w.-]*): +(\S.*)$/.exec(before)
    if (value) {
        const indent = value[1].length
        const parent = indent === 0 ? null : parentKey(lines, index, indent)
        const path = parent === null ? value[2] : `${parent}.${value[2]}`
        return { kind: 'value', key: path, from: caret - value[3].length, to: caret, prefix: value[3] }
    }

    const item = /^( *)- +(\S.*)$/.exec(before)
    if (item) {
        const parent = parentKey(lines, index, item[1].length + 1)
        if (parent === null) return null
        return { kind: 'value', key: parent, from: caret - item[2].length, to: caret, prefix: item[2] }
    }
    return null
}

export interface FrontmatterCompletionItem {
    label: string
    /** The text that replaces what was typed. */
    insert: string
    detail?: string
}

export interface CompletionSources {
    /** The keys the graph's documents use, or [] while unknown. */
    graphKeys: readonly PropertyKeyInfo[]
    /** The values a key has across the graph, or [] while unknown. */
    graphValues: (key: string) => readonly PropertyValueInfo[]
}

function documentsLabel(n: number): string {
    return `${n} ${n === 1 ? 'document' : 'documents'}`
}

/** The keys the block names at the top level. */
function presentKeys(doc: string): Set<string> {
    const span = frontmatterSpan(doc)
    const keys = new Set<string>()
    if (!span) return keys
    for (const line of span.body.split('\n')) {
        const own = /^([^\s#-][^:]*):/.exec(line)
        if (own) keys.add(own[1].trim())
    }
    return keys
}

/**
 * The items that start with what was typed, ignoring case, in the order given. By prefix only: a
 * key is typed from its start, and one letter matching anywhere in every key would bury the one
 * being typed. An item already typed out in full is not offered again.
 */
function ranked<T extends { label: string }>(items: readonly T[], prefix: string): T[] {
    const typed = prefix.toLowerCase()
    return items.filter((item) => {
        const label = item.label.toLowerCase()
        return label.startsWith(typed) && label !== typed
    })
}

export function rankFrontmatterItems(doc: string, ctx: FrontmatterCompletionContext, sources: CompletionSources): FrontmatterCompletionItem[] {
    if (ctx.kind === 'key') {
        if (ctx.parent === 'publication') {
            const settings = Object.entries(PUBLICATION_SETTINGS).map(([label, detail]) => ({ label, insert: `${label}: `, detail }))
            return ranked(settings, ctx.prefix)
        }
        const present = presentKeys(doc)
        const own = FRONTMATTER_PROPERTIES.filter((p) => p.key !== 'includes' && !present.has(p.key)).map((p) => ({ label: p.key, insert: `${p.key}: `, detail: p.summary.replaceAll('`', '') }))
        const ownKeys = new Set(FRONTMATTER_PROPERTIES.map((p) => p.key))
        const theirs = sources.graphKeys
            .filter((k) => !ownKeys.has(k.key) && !k.key.includes('.') && !present.has(k.key))
            .map((k) => ({ label: k.key, insert: `${k.key}: `, detail: documentsLabel(k.documents) }))
        // EtherPK's keys stay ahead of the graph's however well a graph key matches.
        return [...ranked(own, ctx.prefix), ...ranked(theirs, ctx.prefix)]
    }
    const choices = CHOICES[ctx.key]
    if (choices) return ranked(choices.map((label) => ({ label, insert: label })), ctx.prefix)
    if (OWN_VALUE_KEYS.has(ctx.key)) return []
    const values = sources.graphValues(valueSourceOf(ctx.key))
    return ranked(values.map((v) => ({ label: v.value, insert: yamlScalar(v.value), detail: documentsLabel(v.documents) })), ctx.prefix)
}
