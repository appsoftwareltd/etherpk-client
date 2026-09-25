/**
 * What a document's frontmatter says about publishing (ADR 0082).
 *
 * Two halves. **Membership** is on every document: `public: true` is the consent switch, and
 * `publications: [docs, blog]` routes it. **Definition** is on a publication page: the
 * `publication:` mapping is the configuration and the page's body is its navigation outline.
 * The shapes are deliberately different (a mapping defines, a list joins), so a member that
 * writes `publication: docs` by mistake fails the shape check and is told which key it meant.
 *
 * Pure over text. Malformed YAML reads as no frontmatter, as everywhere else (`parseFrontmatter`).
 */

import type { IndexIncludeFact } from '$lib/document/index-db'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'

import type { Publication, PublicationKind, PublicationSelection, PublishDocument, PublishIssue } from './types'

/** A publication id: kebab-case, what `publications:` entries and `theme:` graph ids look like. */
export const PUBLICATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isPublicationId(value: unknown): value is string {
    return typeof value === 'string' && PUBLICATION_ID.test(value)
}

/** The bundled theme a publication starts from when its page names none. */
export function defaultThemeFor(kind: PublicationKind): string {
    return kind === 'blog' ? 'etherpk-blog' : 'etherpk-docs'
}

export interface Membership {
    /** `public: true`, exactly. Anything else is not consent. */
    isPublic: boolean
    /** The valid ids the document names, in order. */
    publications: string[]
    issues: PublishIssue[]
}

/** What a document says about its own publishing. */
export function readMembership(text: string, concept?: string): Membership {
    const { data } = parseFrontmatter(text)
    const issues: PublishIssue[] = []
    const isPublic = data.public === true
    const publications: string[] = []
    const raw = data.publications
    const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null
    if (entries === null) {
        issues.push({
            level: 'warning',
            code: 'publications-not-a-list',
            message: '`publications` must be a list of publication ids, like `publications: [docs, blog]`.',
            concept,
        })
    } else {
        for (const entry of entries) {
            if (isPublicationId(entry)) {
                if (!publications.includes(entry)) publications.push(entry)
            } else {
                issues.push({
                    level: 'warning',
                    code: 'publications-invalid-id',
                    message: `\`publications\` names "${String(entry)}", which is not a publication id (lower-case letters, digits and hyphens).`,
                    concept,
                })
            }
        }
    }
    return { isPublic, publications, issues }
}

export interface PublicationDefinition {
    /** The publication, or null when the page defines none or the definition is invalid. */
    publication: Publication | null
    issues: PublishIssue[]
}

const KINDS: readonly PublicationKind[] = ['docs', 'blog']
/** Posts on a blog's front page when the page sets no `recent`. */
export const DEFAULT_RECENT_POSTS = 10
const SELECTIONS: readonly PublicationSelection[] = ['named', 'all-public']

/** The publication a page defines through its `publication:` mapping, validated. */
export function readPublicationDefinition(doc: PublishDocument): PublicationDefinition {
    const { data, body } = parseFrontmatter(doc.text)
    const raw = data.publication
    if (raw === undefined) return { publication: null, issues: [] }
    const issues: PublishIssue[] = []
    const issue = (code: string, message: string) => issues.push({ level: 'error', code, message, concept: doc.concept })

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        const hint = typeof raw === 'string' ? `publications: [${raw}]` : 'publications: [docs]'
        issue(
            'publication-not-a-mapping',
            `\`publication\` defines a publication and must be a mapping with an id. To make this document part of one, write \`${hint}\` instead.`,
        )
        return { publication: null, issues }
    }
    if (doc.kind === 'journal') {
        issue('publication-on-journal', 'A journal entry cannot define a publication; use a page.')
        return { publication: null, issues }
    }

    const def = raw as Record<string, unknown>
    const id = def.id
    if (id === undefined || id === null || id === '') {
        issue('publication-missing-id', '`publication` needs an `id`: lower-case letters, digits and hyphens, like `docs`.')
    } else if (!isPublicationId(id)) {
        issue('publication-invalid-id', `"${String(id)}" is not a publication id: use lower-case letters, digits and hyphens, like \`docs\`.`)
    }

    const kind = def.kind === undefined ? 'docs' : def.kind
    if (!KINDS.includes(kind as PublicationKind)) {
        issue('publication-invalid-kind', `\`kind\` must be one of ${KINDS.map((k) => `\`${k}\``).join(', ')}.`)
    }
    const selection = def.selection === undefined ? 'named' : def.selection
    if (!SELECTIONS.includes(selection as PublicationSelection)) {
        issue('publication-invalid-selection', `\`selection\` must be \`named\` (documents that name this publication) or \`all-public\` (every public document).`)
    }

    let url: string | undefined
    if (def.url !== undefined) {
        if (typeof def.url === 'string' && /^https?:\/\/\S+$/.test(def.url.trim())) {
            url = def.url.trim().replace(/\/+$/, '')
        } else {
            issue('publication-invalid-url', '`url` must be the site\'s address, starting with `https://` or `http://`.')
        }
    }

    let home: string | undefined
    if (def.home !== undefined) {
        if (typeof def.home === 'string' && def.home.trim() !== '') home = def.home.trim()
        else issue('publication-invalid-home', '`home` must name the concept whose content becomes the front page.')
    }

    let theme = defaultThemeFor((KINDS.includes(kind as PublicationKind) ? kind : 'docs') as PublicationKind)
    if (def.theme !== undefined) {
        if (typeof def.theme === 'string' && def.theme.trim() !== '') theme = def.theme.trim()
        else issue('publication-invalid-theme', '`theme` must be a bundled theme name, a url to a theme manifest, or a graph theme id.')
    }

    // How many posts the front page lists; the rest are on the posts archive. A whole number
    // above zero, so a theme can count on `recentPosts` being non-empty whenever there are posts.
    let recent = DEFAULT_RECENT_POSTS
    if (def.recent !== undefined) {
        if (typeof def.recent === 'number' && Number.isInteger(def.recent) && def.recent > 0) recent = def.recent
        else issue('publication-invalid-recent', '`recent` must be a whole number above zero: how many posts the front page lists (10 unless set).')
    }

    const includes: Record<string, string> = {}
    if (def.includes !== undefined) {
        if (typeof def.includes === 'object' && def.includes !== null && !Array.isArray(def.includes)) {
            for (const [slot, value] of Object.entries(def.includes as Record<string, unknown>)) {
                if (typeof value === 'string' && value.trim() !== '') {
                    includes[slot] = value.trim()
                } else {
                    issues.push({
                        level: 'warning',
                        code: 'publication-invalid-include',
                        message: `Include \`${slot}\` must name the page that fills it; it is ignored.`,
                        concept: doc.concept,
                    })
                }
            }
        } else {
            issue('publication-invalid-includes', '`includes` must be a mapping of include slot to the page that fills it.')
        }
    }

    if (issues.some((i) => i.level === 'error')) return { publication: null, issues }

    const publication: Publication = {
        id: id as string,
        name: typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : doc.concept,
        concept: doc.concept,
        kind: kind as PublicationKind,
        selection: selection as PublicationSelection,
        theme,
        recent,
        includes,
        outline: body,
    }
    if (home !== undefined) publication.home = home
    if (url !== undefined) publication.url = url
    return { publication, issues }
}

/**
 * The snippets a publication page names under `includes:`, as facts for the [[Derived Index]]:
 * what lets a document's tab say it is used in a publication without the graph being read.
 * A page defining no (valid) publication names nothing.
 */
export function includeFactsOf(doc: PublishDocument): IndexIncludeFact[] {
    const { publication } = readPublicationDefinition(doc)
    if (!publication) return []
    return Object.entries(publication.includes).map(([slot, concept]) => ({ publication: publication.id, slot, concept }))
}

export interface DiscoveredPublications {
    /** Valid, uniquely identified publications, by id. */
    publications: Publication[]
    issues: PublishIssue[]
}

/** Every publication the graph defines. Two pages claiming one id are both refused. */
export function discoverPublications(documents: readonly PublishDocument[]): DiscoveredPublications {
    const issues: PublishIssue[] = []
    const byId = new Map<string, Publication[]>()
    for (const doc of documents) {
        const { publication, issues: docIssues } = readPublicationDefinition(doc)
        issues.push(...docIssues)
        if (!publication) continue
        const list = byId.get(publication.id)
        if (list) list.push(publication)
        else byId.set(publication.id, [publication])
    }
    const publications: Publication[] = []
    for (const [id, list] of byId) {
        if (list.length === 1) {
            publications.push(list[0])
            continue
        }
        for (const publication of list) {
            issues.push({
                level: 'error',
                code: 'publication-duplicate-id',
                message: `Two pages define the publication "${id}" (${list.map((p) => `"${p.concept}"`).join(' and ')}); neither is published until one is changed.`,
                concept: publication.concept,
            })
        }
    }
    publications.sort((a, b) => a.id.localeCompare(b.id))
    return { publications, issues }
}
