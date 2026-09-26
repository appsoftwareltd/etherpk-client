/**
 * The workspace's side of publishing (ADR 0082): the frontmatter writes the Publish surfaces
 * make (a document's `public` and `publications`, a publication page's `publication:` mapping),
 * copying a theme into the graph, and running a publish end to end. Framework-free, so it is
 * unit-tested over the in-memory store; the Svelte surfaces only call it.
 *
 * Every frontmatter write goes through the document's live handle and replaces only the block
 * (the server store's own `writeBackIdentity` rule): the body is untouched, an open editor sees
 * the change, and on a synced graph it is one CRDT edit for the other members.
 */

import { bundledTheme } from '@appsoftwareltd/etherpk-themes'

import { withAliasesInAddedBlock } from '$lib/document/frontmatter/identity'
import { withFrontmatterPatch } from '$lib/document/frontmatter/patch'
import { type PublishingPatch, withPublishing } from '$lib/document/frontmatter/publishing'
import { agentsMdWithManagedSection, seededFiles } from '$lib/document/publish/seeded'
import { type PublishEnvironment, type PublishReport, publishPublication } from '$lib/document/publish/publish'
import { type PublicationKind, type PublicationSelection, type Publication, type PublishSource } from '$lib/document/publish/types'
import { DEFAULT_RECENT_POSTS, discoverPublications, isPublicationId, readMembership, readPublicationDefinition } from '$lib/document/publish/publication'
import { containsCipherFence } from '$lib/document/protection/fence-info'
import { publicDocumentsInNoPublication } from '$lib/document/publish/selection'
import { type GraphTheme, graphThemeFromFiles, isGraphThemeId } from '$lib/document/publish/theme/graph-theme'
import { fetchTheme, isThemeUrl } from '$lib/document/publish/theme/sources'
import type { DocumentStore } from '$lib/document/types'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { conceptKey } from '$lib/storage/fs/identity'
import { publishSlug } from '$lib/document/wikilink/derive'

/**
 * A store the frontmatter writers can use. A Filesystem store writes on an autosave debounce
 * and offers `flushDocument`; the writers wait for it, because the Publish tab re-reads the
 * graph from the folder straight after a save and would otherwise see the page as it was.
 */
export interface FrontmatterStore extends DocumentStore {
    flushDocument?(target: string): Promise<void>
    /**
     * Every document's identity key and aliases, as the registry holds them. A writer that adds a
     * block to a document carries its aliases in from here (`withAliasesInAddedBlock`). Both real
     * stores have it; a store without it is treated as holding no aliases outside any block.
     */
    listDocuments?(): readonly { key: string; aliases: readonly string[] }[]
}

/** Replace a document's frontmatter block with the one `rewrite` produces, through its live handle. */
export async function rewriteFrontmatter(store: FrontmatterStore, concept: string, rewrite: (text: string) => string): Promise<boolean> {
    await store.whenReady?.(concept)
    // Edits still inside a Filesystem store's autosave are written first, so its listing - which
    // a local graph reads from the file - agrees with the text before any aliases are carried.
    await store.flushDocument?.(concept)
    const handle = store.open(concept)
    const text = handle.getText()
    const next = withAliasesInAddedBlock(text, rewrite(text), registryAliases(store, concept))
    if (next === text) return false
    const before = frontmatterSpan(text)?.end ?? 0
    const after = frontmatterSpan(next)?.end ?? 0
    handle.applyChange({ from: 0, to: before, insert: next.slice(0, after) }, 'external')
    await store.flushDocument?.(concept)
    return true
}

/** The document's aliases as its store's registry holds them, found by its identity key. */
function registryAliases(store: FrontmatterStore, concept: string): readonly string[] {
    const key = conceptKey(concept)
    return store.listDocuments?.().find((entry) => entry.key === key)?.aliases ?? []
}

/** Set a document's `public` and `publications` (adding a block if it has none). */
export function setDocumentPublishing(store: FrontmatterStore, concept: string, patch: PublishingPatch): Promise<boolean> {
    return rewriteFrontmatter(store, concept, (text) => withPublishing(text, patch, { addBlock: true }))
}

export interface NewPublicationInput {
    /** The page's title, which is the publication's display name. */
    title: string
    id: string
    kind: PublicationKind
    selection: PublicationSelection
    home?: string
    url?: string
}

/** A publication id from a title: `Docs Site` → `docs-site`. */
export function suggestPublicationId(title: string): string {
    return publishSlug(title)
}

export function publicationMapping(input: Omit<NewPublicationInput, 'title'>): Record<string, unknown> {
    const mapping: Record<string, unknown> = { id: input.id, kind: input.kind, selection: input.selection }
    if (input.home && input.home.trim() !== '') mapping.home = input.home.trim()
    if (input.url && input.url.trim() !== '') mapping.url = input.url.trim()
    return mapping
}

export interface PublicationPageCreator {
    createPage(title: string, body?: string): Promise<string>
}

/**
 * What a new publication page says above its outline: what the page is for and how the outline
 * becomes the menu. A paragraph, which the nav builder skips, with no brackets in it (a wikilink
 * here would be a menu entry). A page seeded with one bullet and nothing else read as an empty
 * page whose purpose was anyone's guess (2026-09-19).
 */
export function publicationPageIntro(name: string): string {
    return (
        `This page defines the publication "${name}". Its settings are the frontmatter above; edit them in ` +
        'Settings → Publish rather than here. The outline below is the site\'s navigation: one bullet per menu ' +
        'entry, written as a wikilink to the page; nested bullets are sub-entries; a plain bullet with children is ' +
        'a group; a markdown link is an outside link. A page that is public and in this publication but not ' +
        'listed here is still on the site, reachable by search and links, just not in the menu.'
    )
}

/**
 * Create a publication page: a page whose frontmatter defines the publication and whose body
 * is a short explanation and an outline seeded with the home page. Returns the page's concept.
 */
export async function createPublicationPage(store: FrontmatterStore & PublicationPageCreator, input: NewPublicationInput): Promise<string> {
    if (!isPublicationId(input.id)) throw new Error(`"${input.id}" is not a publication id: use lower-case letters, digits and hyphens.`)
    const outline = input.home && input.home.trim() !== '' ? `- [[${input.home.trim()}]]\n` : ''
    const concept = await store.createPage(input.title.trim(), `${publicationPageIntro(input.title.trim())}\n\n${outline}`)
    await rewriteFrontmatter(store, concept, (text) => withFrontmatterPatch(text, { publication: publicationMapping(input) }, { addBlock: true }))
    return concept
}

/**
 * What a save from the Publish tab can change on a publication page. A field set to null or
 * blank is removed from the mapping (back to its default); an include slot set to null or blank
 * is cleared. Everything arrives in one call so the page is rewritten once.
 */
export interface PublicationChanges extends Partial<Record<'kind' | 'selection' | 'home' | 'url' | 'theme', string | null>> {
    includes?: Record<string, string | null>
    /** Posts on the front page; null or the default (10) removes the key. */
    recent?: number | null
}

/** Rewrite a publication page's mapping with `changes`, keeping everything else as it is. */
export function updatePublicationPage(store: FrontmatterStore, concept: string, current: Publication, changes: PublicationChanges): Promise<boolean> {
    const { includes: includeChanges, recent: recentChange, ...fieldChanges } = changes
    const includes: Record<string, string> = { ...current.includes }
    const recent = recentChange === undefined ? current.recent : (recentChange ?? DEFAULT_RECENT_POSTS)
    for (const [slot, page] of Object.entries(includeChanges ?? {})) {
        if (page === null || page.trim() === '') delete includes[slot]
        else includes[slot] = page.trim()
    }
    return rewriteFrontmatter(store, concept, (text) => {
        const mapping: Record<string, unknown> = { id: current.id, kind: current.kind, selection: current.selection }
        if (current.home !== undefined) mapping.home = current.home
        if (current.url !== undefined) mapping.url = current.url
        mapping.theme = current.theme
        for (const [key, value] of Object.entries(fieldChanges)) {
            if (value === null || value === undefined || value === '') delete mapping[key]
            else mapping[key] = value
        }
        // The default stays implicit, so a page that never set it does not grow a key.
        if (recent !== DEFAULT_RECENT_POSTS) mapping.recent = recent
        if (Object.keys(includes).length > 0) mapping.includes = includes
        return withFrontmatterPatch(text, { publication: mapping }, { addBlock: true })
    })
}

/** Set one include slot of a publication page to a page (null clears it). */
export function setPublicationInclude(store: FrontmatterStore, concept: string, current: Publication, slot: string, page: string | null): Promise<boolean> {
    return updatePublicationPage(store, concept, current, { includes: { [slot]: page } })
}

export interface ThemeCopyDeps {
    fetchText?(url: string): Promise<string>
    existingIds: readonly string[]
}

/** A free graph theme id from a wanted one: `my-docs`, then `my-docs-2`, ... */
export function freeThemeId(wanted: string, existing: readonly string[]): string {
    const base = publishSlug(wanted) || 'theme'
    let id = base
    for (let n = 2; existing.includes(id); n++) id = `${base}-${n}`
    return id
}

/** Copy a bundled theme or a url theme into a graph theme, ready to save. */
export async function copyThemeForGraph(ref: string, id: string, name: string, deps: ThemeCopyDeps): Promise<GraphTheme> {
    if (!isGraphThemeId(id)) throw new Error(`"${id}" is not a theme id: use lower-case letters, digits and hyphens.`)
    if (deps.existingIds.includes(id)) throw new Error(`The graph already has a theme called "${id}".`)
    if (isThemeUrl(ref)) {
        if (!deps.fetchText) throw new Error('This host cannot fetch a theme from a url.')
        const fetched = await fetchTheme(ref, deps.fetchText)
        const files = new Map(fetched.files)
        // The manifest travels too, so the copy stands on its own.
        files.set('theme.json', await deps.fetchText(ref))
        return graphThemeFromFiles(id, name, files, ref)
    }
    const bundled = bundledTheme(ref)
    if (!bundled) throw new Error(`No bundled theme is called "${ref}".`)
    return graphThemeFromFiles(id, name, bundled.files, ref)
}

export interface GraphPublishingSummary {
    publications: Publication[]
    issues: ReturnType<typeof discoverPublications>['issues']
    publicInNoPublication: string[]
    /**
     * Every document, with what decides whether a publish takes it, so a field that names a
     * page (home, an include) can say in place why that page would not be on the site.
     */
    documents: PublishDocumentSummary[]
}

/** What the Publish tab needs to know about one document, read the way `selectDocuments` reads it. */
export interface PublishDocumentSummary {
    concept: string
    aliases: readonly string[]
    isPublic: boolean
    publications: readonly string[]
    isProtected: boolean
    /** A page whose frontmatter defines a publication; never published itself. */
    isPublicationPage: boolean
}

/** What the Publish tab shows: the publications a graph defines and the public documents none takes. */
export function summarisePublishing(source: PublishSource): GraphPublishingSummary {
    const discovered = discoverPublications(source.documents)
    const documents = source.documents.map((doc): PublishDocumentSummary => {
        const membership = readMembership(doc.text)
        return {
            concept: doc.concept,
            aliases: doc.aliases,
            isPublic: membership.isPublic,
            publications: membership.publications,
            isProtected: containsCipherFence(doc.text),
            isPublicationPage: readPublicationDefinition(doc).publication !== null,
        }
    })
    return {
        publications: discovered.publications,
        issues: discovered.issues,
        publicInNoPublication: publicDocumentsInNoPublication(source.documents, discovered.publications).map((d) => d.concept),
        documents,
    }
}

export interface PublishRunDeps {
    source: PublishSource
    environment: PublishEnvironment
    /** Documents whose text this device could not confirm; they are not in `source` and the report says so. */
    unsettled?: readonly string[]
    onProgress?: Parameters<typeof publishPublication>[3] extends { onProgress?: infer P } | undefined ? P : never
}

export interface PublishRun {
    report: PublishReport
    bundle: Map<string, string | Uint8Array>
    seeded: Map<string, string>
    agentsMd(existing: string | null): string
}

/** Publish one publication to a bundle, with the seeded files and AGENTS.md the host may write. */
export async function runPublish(publication: Publication, deps: PublishRunDeps): Promise<PublishRun> {
    const { bundle, report } = await publishPublication(deps.source, publication, deps.environment, { onProgress: deps.onProgress })
    if (deps.unsettled && deps.unsettled.length > 0) {
        report.warnings.push({
            level: 'warning',
            code: 'documents-unsettled',
            message: `${deps.unsettled.length} document${deps.unsettled.length === 1 ? ' has' : 's have'} not finished syncing to this device and ${deps.unsettled.length === 1 ? 'was' : 'were'} left out: ${deps.unsettled.slice(0, 5).join(', ')}${deps.unsettled.length > 5 ? '…' : ''}. Publish again once sync has caught up.`,
        })
    }
    // The report stays OUT of the bundle. It names every document the site leaves out, protected
    // ones included, and says which linked names are real private pages; a static host serves
    // whatever the folder holds, so a copy there would publish exactly what the site withholds.
    // The Publish tab shows it and the Headless Client returns it instead. The name is an owned
    // path (site-writer.ts), so a publish deletes any copy left in the folder.
    return {
        report,
        bundle,
        seeded: seededFiles(publication),
        agentsMd: (existing) => agentsMdWithManagedSection(existing, publication),
    }
}
