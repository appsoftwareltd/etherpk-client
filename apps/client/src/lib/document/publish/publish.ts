/**
 * The publisher (ADR 0082): one [[Publication]] of a knowledge graph rendered into a
 * [[Published Site]] as a map of files, plus the report that says what was included, what was
 * left out and why. Framework-free: the Client and the Headless Client hand it materialised
 * documents and a way to read assets and themes, and write the files it returns.
 *
 * Order of work, and why: selection first (protection wins before anything else looks at a
 * document); slugs and the resolver next (every link and every name goes through them);
 * a pre-render pass for the asynchronous bits (diagrams, code); then rendering, includes, the
 * theme, the derived files. Everything derived is computed from the included documents alone.
 */

import { parseFrontmatter } from '$lib/storage/fs/frontmatter'

import { backlinksFor, conceptKey } from '../backlinks/backlink-index'
import { extensionOfFence, isExtensionFenceInfo } from '../extension-fence'
import { checkedFenceAnswer } from '../fence-answer'
import { MAP_FENCE_INFO, mapAltText } from '../map-text'
import { wikilinkOccurrencesInSource } from '../wikilink/source'
import { searchIndexJson, searchIndexScript, sitemapXml, feedXml, type SearchEntry, type FeedItem, type SitemapEntry } from './derived'
import {
    type BacklinkView,
    type NavViewNode,
    type PageSummary,
    archiveHtml,
    postsArchiveHtml,
    postsByYear,
    backlinksHtml,
    indexHtml,
    navFor,
    navHtml,
    tocHtml,
} from './fragments'
import { withDiagramId } from './diagram-id'
import { highlightCode as defaultHighlight } from './highlight'
import { type DocumentRenderer, type FenceOutputRef, type RenderedDocument, type TocItem, createDocumentRenderer } from './markdown/render'
import { type NavNode, buildNav } from './nav'
import { discoverPublications, readPageDate } from './publication'
import { type PublicationResolver, createPublicationResolver, titleText } from './resolve'
import { type ExcludedDocument, includeStatus, publicDocumentsInNoPublication, selectDocuments } from './selection'
import { type SlugCollision, allocateSlugs, explicitSlugOf } from './slugs'
import { THEME_CONTRACT, type ThemeFiles, themeFileErrors } from './theme/manifest'
import { createThemeRenderer } from './theme/render'
import type { Publication, PublishDocument, PublishIssue, PublishSource, SiteBundle } from './types'

export type ThemeSourceKind = 'bundled' | 'url' | 'graph'

export interface LoadedTheme {
    theme: ThemeFiles
    source: ThemeSourceKind
}

/** What a host supplies: the things that differ between the browser and Node. */
export interface PublishEnvironment {
    /** Resolve a theme reference (a bundled name, a url, a graph theme id). Throws with the reason on failure. */
    loadTheme(ref: string): Promise<LoadedTheme>
    /** Pre-render a Mermaid diagram to SVG. Absent where there is no browser. */
    renderMermaid?(source: string): Promise<string>
    /** Highlight a fence; the lezer highlighter by default. */
    highlightCode?(lang: string, code: string): Promise<string | null>
    /** KaTeX's stylesheet and fonts, path under `theme/katex/` → content, copied in when the publication has maths. */
    katexAssets?(): Promise<ReadonlyMap<string, string | Uint8Array>>
    /**
     * Draw a [[Map Block]], by its fence's body, as a picture: its places, routes and their names
     * over the basemap, framed as the map opens, in the light style, with the basemap's credit.
     * Rejects with why it could not. Absent where the host cannot draw maps, and then a
     * publication holding one stops: a map is never left out of a page without a word, and never
     * printed as its lines, which hold where each place is (ADR 0118).
     */
    renderMap?(source: string): Promise<MapPicture>
    /**
     * How a site shows a fence an extension draws (its registration's `publish`): a picture or a
     * link, never HTML. Undefined when nothing here publishes fences of that info word, which is so
     * for every one where no extension runs, as in the Headless Client: an [[Extension Fence]] is
     * then left out (ADR 0138), and any other fence published as code.
     */
    publishFence?(fence: { info: string; body: readonly string[]; document: string }): Promise<PublishedFenceOutput | null> | undefined
    now?(): Date
}

/** What an extension makes of a fence for a published site (the Extension API's `PublishedFence`). */
export type PublishedFenceOutput =
    | { kind: 'picture'; type: 'image/svg+xml' | 'image/png' | 'image/webp'; bytes: Uint8Array; width: number; height: number; alt: string }
    | { kind: 'link'; href: string; text: string; image?: { src: string; alt: string; width?: number; height?: number } }

/** A Map Block drawn by the host. */
export interface MapPicture {
    bytes: Uint8Array
    type: 'image/png' | 'image/webp'
    /** The picture's size in CSS pixels, which the page reserves before it loads. */
    width: number
    height: number
}

/**
 * Bumped when the way a map is drawn changes, so a site published again holds the new picture
 * under a new name rather than a cached one under the old. 2: a name that would run past the
 * picture's edge is shortened with an ellipsis.
 */
const MAP_PICTURE_VERSION = 2

/** A picture's file name: from what the map holds and how it is drawn, so an unchanged map publishes the same file. */
async function mapPictureName(source: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${MAP_PICTURE_VERSION}\n${source}`))
    return [...new Uint8Array(digest)]
        .slice(0, 8)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

/** A fence's body as lines, as an extension's widget reads it: markdown-it's content ends with a line break. */
function bodyLines(code: string): string[] {
    const lines = code.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
}

const PICTURE_EXTENSIONS = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp' } as const

/**
 * What an extension's `publish` answered for a fence, checked (`fence-answer.ts`), its picture kept
 * for the site under a name taken from its bytes: a picture, a link (`https` only, as is any picture
 * in it), null when it is left out, or undefined when it could not be made, after which an ordinary
 * fence is published as code and an Extension Fence left out, with a warning either way.
 */
async function publishedFence(
    asked: Promise<PublishedFenceOutput | null>,
    info: string,
    concept: string,
    pictures: Map<string, Uint8Array>,
    warnings: PublishIssue[],
): Promise<FenceOutputRef | null | undefined> {
    try {
        // Checked as a quote's answer is (fence-answer.ts): read once, bytes copied, https links only.
        const out = checkedFenceAnswer(await asked)
        if (out === null) return null
        if (out.kind === 'picture') {
            const digest = await crypto.subtle.digest('SHA-256', out.bytes as Uint8Array<ArrayBuffer>)
            const name = [...new Uint8Array(digest)]
                .slice(0, 8)
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('')
            const path = `pictures/${name}.${PICTURE_EXTENSIONS[out.type]}`
            pictures.set(path, out.bytes)
            return { kind: 'picture', src: path, alt: out.alt, width: Math.round(out.width), height: Math.round(out.height) }
        }
        return { kind: 'link', href: out.href, text: out.text, ...(out.image ? { image: out.image } : {}) }
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        const extensionFence = isExtensionFenceInfo(info)
        warnings.push({
            level: 'warning',
            code: 'extension-fence-failed',
            message: `A \`${info}\` block in "${concept}" could not be published: ${why}. ${extensionFence ? 'It is left out.' : 'It is published as its text.'}`,
            concept,
        })
        return extensionFence ? null : undefined
    }
}

export interface PublishProgress {
    phase: 'selecting' | 'rendering' | 'assets' | 'writing'
    done: number
    total: number
}

export interface PublishOptions {
    onProgress?(progress: PublishProgress): void
}

export interface IncludedDocument {
    concept: string
    kind: 'page' | 'journal'
    slug: string
    url: string
}

export interface MissingLink {
    /** The document holding the link. */
    from: string
    concept: string
    status: 'elsewhere' | 'private' | 'missing'
    publishedIn?: string[]
}

export interface IncludeUse {
    name: string
    source: 'page' | 'theme'
    concept?: string
}

export interface PublishReport {
    publication: { id: string; name: string; kind: string; theme: string }
    generatedAt: string
    /** False when an error stopped the publish; the bundle is then empty. */
    ok: boolean
    errors: PublishIssue[]
    warnings: PublishIssue[]
    info: PublishIssue[]
    included: IncludedDocument[]
    excluded: ExcludedDocument[]
    collisions: SlugCollision[]
    missingLinks: MissingLink[]
    assets: { copied: string[]; missing: { name: string; from: string }[] }
    theme?: { source: ThemeSourceKind; name: string; version: string }
    includes: IncludeUse[]
    /** Resources the site loads from elsewhere, so the choice is visible. */
    external: string[]
    /** Public documents that no publication takes (a graph-wide observation). */
    publicInNoPublication: string[]
}

export interface PublishResult {
    bundle: SiteBundle
    report: PublishReport
}

interface RenderedPage {
    doc: PublishDocument
    slug: string
    url: string
    date?: string
    rendered: RenderedDocument
    title: string
    titleHtml: string
    isHome: boolean
}

function assetHrefOf(name: string): string {
    return `assets/${encodeURIComponent(name)}`
}

function bodyOf(doc: PublishDocument): string {
    return parseFrontmatter(doc.text).body
}

/** Every `http(s)` resource a piece of HTML or CSS pulls in, for the report. */
function externalResources(text: string): string[] {
    const out = new Set<string>()
    for (const m of text.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/g)) out.add(m[1])
    for (const m of text.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"')\s]+)/g)) out.add(m[1])
    for (const m of text.matchAll(/url\(["']?(https?:\/\/[^"')\s]+)/g)) out.add(m[1])
    return [...out]
}

export async function publishPublication(
    source: PublishSource,
    publication: Publication,
    env: PublishEnvironment,
    options: PublishOptions = {},
): Promise<PublishResult> {
    const now = env.now?.() ?? new Date()
    const generatedAt = now.toISOString()
    const errors: PublishIssue[] = []
    const warnings: PublishIssue[] = []
    const info: PublishIssue[] = []
    const take = (issues: readonly PublishIssue[]) => {
        for (const issue of issues) (issue.level === 'error' ? errors : issue.level === 'warning' ? warnings : info).push(issue)
    }
    const report: PublishReport = {
        publication: { id: publication.id, name: publication.name, kind: publication.kind, theme: publication.theme },
        generatedAt,
        ok: false,
        errors,
        warnings,
        info,
        included: [],
        excluded: [],
        collisions: [],
        missingLinks: [],
        assets: { copied: [], missing: [] },
        includes: [],
        external: [],
        publicInNoPublication: [],
    }
    const bundle: SiteBundle = new Map()
    const progress = (phase: PublishProgress['phase'], done: number, total: number) => options.onProgress?.({ phase, done, total })

    // 1. Selection. Protection wins before anything else looks at a document.
    progress('selecting', 0, 0)
    const discovered = discoverPublications(source.documents)
    take(discovered.issues.filter((i) => i.concept === publication.concept || i.code === 'publication-duplicate-id'))
    const allPublications = discovered.publications.some((p) => p.id === publication.id)
        ? discovered.publications
        : [...discovered.publications, publication]
    const selection = selectDocuments(source.documents, publication, allPublications)
    take(selection.issues)
    report.excluded = selection.excluded
    report.publicInNoPublication = publicDocumentsInNoPublication(source.documents, allPublications).map((d) => d.concept)

    // 2. Slugs, the home concept, the resolver.
    const homeKey = publication.home === undefined ? null : conceptKey(publication.home)
    const included = selection.included
    const homeDoc = homeKey === null ? undefined : included.find((d) => conceptKey(d.concept) === homeKey || d.aliases.some((a) => conceptKey(a) === homeKey))
    if (homeKey !== null && !homeDoc) {
        warnings.push({
            level: 'warning',
            code: 'home-not-published',
            message: `The home page "${publication.home}" is not in this publication - the front page lists the published pages instead.`,
        })
    }
    const allocation = allocateSlugs.withReport(included.filter((d) => d !== homeDoc))
    const slugs = new Map(allocation.slugs)
    if (homeDoc) slugs.set(conceptKey(homeDoc.concept), 'index')
    report.collisions = allocation.collisions
    reportAddresses(allocation, homeDoc, warnings, info)
    const publishedElsewhere = new Map<string, string[]>()
    for (const e of selection.excluded) if (e.publishedIn) publishedElsewhere.set(conceptKey(e.concept), e.publishedIn)
    const resolver = createPublicationResolver({ included, allDocuments: source.documents, slugs, publishedElsewhere })

    // 3. The theme, early: a theme that cannot render is the one error worth stopping for.
    const theme = await loadPublicationTheme(publication, env, report)
    if (!theme) return { bundle, report }

    // 4. The pre-render pass: diagrams and code, over every body that will be rendered.
    const includeDocs = includePages(publication, source, warnings)
    const probe = createDocumentRenderer({ resolve: resolver.resolve, assetHref: assetHrefOf })
    const bodies = [...included, ...includeDocs.values()].map((d) => ({ doc: d, body: bodyOf(d) }))
    const { mermaidSvg, mapPictures, fenceOutputs, fencePictures, highlighted } = await prerenderFences(bodies, probe, env, warnings, errors)
    // A map that could not be drawn stops the publish (ADR 0084's rule): the alternative is a
    // page that silently lacks it.
    if (errors.length > 0) return { bundle, report }
    // Each drawn diagram gets an id of its own where it is placed (diagram-id.ts):
    // `mermaid_<page slug>_<n>` in a page's body and `mermaid__<slot>_<n>` in an include. A slug
    // is never empty and never holds `_`, so the two forms cannot meet on one page, and neither
    // can a heading's id (`publishSlug`, no `_`). Counted per render, in document order, so the
    // ids do not depend on the host's render counter and an unchanged page publishes the same
    // bytes. `diagramScope` is set before each render below.
    let diagramScope = { prefix: 'mermaid', n: 0 }
    const scopeDiagrams = (prefix: string) => {
        diagramScope = { prefix: prefix.replace(/[^A-Za-z0-9_-]/g, '-'), n: 0 }
    }
    const renderer: DocumentRenderer = createDocumentRenderer({
        resolve: resolver.resolve,
        assetHref: assetHrefOf,
        mermaidSvg: (src) => {
            const svg = mermaidSvg.get(src)
            return svg === undefined ? undefined : withDiagramId(svg, `${diagramScope.prefix}_${++diagramScope.n}`)
        },
        highlighted: (lang, code) => highlighted.get(`${lang}\n${code}`),
        mapPicture: (src) => {
            const picture = mapPictures.get(src)
            return picture && { src: picture.path, alt: picture.alt, width: picture.width, height: picture.height }
        },
        fenceOutput: (lang, code) => fenceOutputs.get(`${lang}\n${code}`),
    })

    // 5. Render every document.
    const pages = renderPages(included, slugs, homeDoc, renderer, scopeDiagrams, resolver, report, take, progress)
    progress('rendering', included.length, included.length)

    // 6. Navigation and the include pages.
    const navResult = buildNav(publication.outline, resolver)
    take(navResult.issues)
    const journals = pages.filter((p) => p.doc.kind === 'journal').sort((a, b) => b.doc.concept.localeCompare(a.doc.concept))
    const plainPages = pages.filter((p) => p.doc.kind === 'page' && !p.isHome).sort((a, b) => conceptKey(a.title).localeCompare(conceptKey(b.title)))
    const nav = siteMenu(publication, navResult.nav, plainPages, journals.length > 0)

    const { includes, customCss } = renderIncludes(includeDocs, theme, renderer, scopeDiagrams, warnings, report)

    // 7. The view and the theme.
    const themeRenderer = createThemeRenderer(theme, includes)
    const hasMath = pages.some((p) => p.rendered.hasMath) || [...includes.values()].some((h) => h.includes('class="katex"'))
    const dated = pages.filter((p) => p.date !== undefined).sort((a, b) => (b.date as string).localeCompare(a.date as string))
    const { site, pageSummaries, journalSummaries, postSummaries, hasPostsArchive } = siteView(publication, now, journals, plainPages, dated, hasMath, customCss)

    const view: ViewContext = { site, nav, dated, resolver, renderer, pageSummaries, journalSummaries, postSummaries }
    const viewFor = (page: RenderedPage | null, extra: Partial<PageView>) => pageViewFor(view, page, extra)

    progress('writing', 0, pages.length + 3)
    writeLayouts({ pages, hasHome: homeDoc !== undefined, hasJournals: journals.length > 0, hasPostsArchive, publication, nav, pageSummaries, journalSummaries, postSummaries, themeRenderer, viewFor, bundle })

    // 8. Assets: reachable from a rendered document or an include, and nothing else.
    await copyReferencedAssets(pages, includeDocs, renderer, source, bundle, report, warnings, progress)
    await copySiteFiles({ mapPictures, fencePictures, theme, customCss, hasMath, env, bundle, warnings })

    // 9. Derived files, from the included documents alone.
    writeDerivedFiles(pages, dated, publication, journals.length > 0, hasPostsArchive, bundle, info)
    bundle.set('.nojekyll', '')

    // 10. What the site loads from elsewhere.
    report.external = externalResourcesOf(includes, theme, customCss)
    if (pages.some((p) => p.rendered.mermaidFallback)) {
        warnings.push({ level: 'warning', code: 'mermaid-not-prerendered', message: 'A diagram was not pre-rendered on this host and is left as its source - publish from the browser, or run `etherpk-mcp diagrams setup`, to get inline SVG.' })
    }

    progress('writing', pages.length + 3, pages.length + 3)
    report.ok = errors.length === 0
    return { bundle, report }
}

/**
 * Load the publication's theme and check it. Null when it cannot be loaded or its files are
 * invalid: the errors are in `report`, and nothing can be rendered without it.
 */
async function loadPublicationTheme(publication: Publication, env: PublishEnvironment, report: PublishReport): Promise<ThemeFiles | null> {
    let loaded: LoadedTheme
    try {
        loaded = await env.loadTheme(publication.theme)
    } catch (error) {
        report.errors.push({ level: 'error', code: 'theme-unavailable', message: error instanceof Error ? error.message : String(error) })
        return null
    }
    const theme = loaded.theme
    report.theme = { source: loaded.source, name: theme.manifest.name, version: theme.manifest.version }
    for (const message of themeFileErrors(theme)) report.errors.push({ level: 'error', code: 'theme-invalid', message })
    if (report.errors.length > 0) return null
    if (theme.manifest.contract < THEME_CONTRACT) {
        report.warnings.push({ level: 'warning', code: 'theme-older-contract', message: `The theme "${theme.manifest.name}" was written for view contract ${theme.manifest.contract} - this EtherPK writes contract ${THEME_CONTRACT}. It is rendered as is - newer view fields are simply absent to it.` })
    }
    if (!theme.manifest.kinds.includes(publication.kind)) {
        report.warnings.push({ level: 'warning', code: 'theme-kind-mismatch', message: `The theme "${theme.manifest.name}" is made for ${theme.manifest.kinds.join(' and ')} publications - this one is ${publication.kind}.` })
    }
    return theme
}

/**
 * The site's menu: the outline's, or without one, a docs site's every page and a blog's undated
 * pages (an About, a Contact), because its posts are the front page and posts.html, and a menu of
 * every post is a header thirty lines deep. The journal is added when there is one.
 */
function siteMenu(publication: Publication, outlined: NavNode[], plainPages: readonly RenderedPage[], hasJournals: boolean): NavNode[] {
    let nav = outlined
    if (nav.length === 0) {
        const menuPages = publication.kind === 'blog' ? plainPages.filter((p) => p.date === undefined) : plainPages
        nav = menuPages.map((p) => ({ label: p.title, labelHtml: p.titleHtml, href: p.url, concept: p.doc.concept, children: [] }))
    }
    if (hasJournals && !nav.some((n) => n.href === 'journal.html')) {
        nav = [...nav, { label: 'Journal', labelHtml: 'Journal', href: 'journal.html', children: [] }]
    }
    return nav
}

/** Render every included document into a page, noting its date and the links that lead nowhere. */
function renderPages(
    included: readonly PublishDocument[],
    slugs: ReadonlyMap<string, string>,
    homeDoc: PublishDocument | undefined,
    renderer: DocumentRenderer,
    scopeDiagrams: (prefix: string) => void,
    resolver: PublicationResolver,
    report: PublishReport,
    take: (issues: readonly PublishIssue[]) => void,
    progress: (phase: PublishProgress['phase'], done: number, total: number) => void,
): RenderedPage[] {
    const pages: RenderedPage[] = []
    let done = 0
    for (const doc of included) {
        progress('rendering', done++, included.length)
        const slug = slugs.get(conceptKey(doc.concept)) as string
        scopeDiagrams(`mermaid_${slug}`)
        const rendered = renderer.render(bodyOf(doc))
        const isHome = doc === homeDoc
        const page: RenderedPage = {
            doc,
            slug,
            url: `${slug}.html`,
            rendered,
            title: titleText(doc.concept),
            titleHtml: resolver.titleHtml(doc.concept),
            isHome,
        }
        if (doc.kind === 'journal') page.date = doc.concept
        else {
            const dated = readPageDate(doc)
            if (dated.date !== undefined) page.date = dated.date
            take(dated.issues)
        }
        for (const link of linksOf(bodyOf(doc), resolver, doc)) report.missingLinks.push(link)
        pages.push(page)
        report.included.push({ concept: doc.concept, kind: doc.kind, slug, url: page.url })
    }
    return pages
}

/**
 * The `site` part of every view, and the lists the generated pages show. `dated` is newest first.
 */
function siteView(
    publication: Publication,
    now: Date,
    journals: RenderedPage[],
    plainPages: RenderedPage[],
    dated: RenderedPage[],
    hasMath: boolean,
    customCss: string,
) {
    const summaries = (list: RenderedPage[]): PageSummary[] =>
        list.map((p) => ({ title: p.title, titleHtml: p.titleHtml, url: p.url, kind: p.doc.kind, ...(p.date ? { date: p.date } : {}), excerpt: p.rendered.excerpt }))
    const pageSummaries = summaries(plainPages)
    // The pages that are not posts: what a blog's sidebar lists beside its years (About,
    // Contact), where listing every dated page again would double the archive.
    const undatedPageSummaries = summaries(plainPages.filter((p) => p.date === undefined))
    const journalSummaries = summaries(journals)
    const postSummaries = summaries(dated)
    // A blog's front page lists the latest few and the posts archive lists them all by year, so
    // a site of hundreds of posts never pages; a docs site has posts only incidentally and no
    // archive page of them.
    const recentPosts = postSummaries.slice(0, publication.recent)
    const hasPostsArchive = publication.kind === 'blog' && postSummaries.length > 0
    const site = {
        title: publication.name,
        url: publication.url ?? '',
        hasUrl: publication.url !== undefined,
        kind: publication.kind,
        isDocs: publication.kind === 'docs',
        isBlog: publication.kind === 'blog',
        year: String(now.getFullYear()),
        generatedAt: now.toISOString(),
        hasJournals: journals.length > 0,
        hasPosts: postSummaries.length > 0,
        hasMath,
        hasCustomCss: customCss !== '',
        hasFeed: publication.url !== undefined && postSummaries.length > 0,
        pages: pageSummaries,
        undatedPages: undatedPageSummaries,
        hasUndatedPages: undatedPageSummaries.length > 0,
        journals: journalSummaries,
        posts: postSummaries,
        recentPosts,
        postCount: postSummaries.length,
        hasMorePosts: postSummaries.length > recentPosts.length,
        postsByYear: postsByYear(postSummaries),
        postsUrl: 'posts.html',
        hasPostsArchive,
        search: { url: 'search.json', scriptUrl: 'search-index.js' },
        contract: THEME_CONTRACT,
    }
    return { site, pageSummaries, journalSummaries, postSummaries, hasPostsArchive }
}

/** The pictures the pre-render made, the theme's own assets, the custom CSS, and KaTeX when there is maths. */
async function copySiteFiles({ mapPictures, fencePictures, theme, customCss, hasMath, env, bundle, warnings }: {
    mapPictures: Prerendered['mapPictures']
    fencePictures: Prerendered['fencePictures']
    theme: ThemeFiles
    customCss: string
    hasMath: boolean
    env: PublishEnvironment
    bundle: SiteBundle
    warnings: PublishIssue[]
}): Promise<void> {
    for (const picture of mapPictures.values()) bundle.set(picture.path, picture.bytes)
    for (const [path, bytes] of fencePictures) bundle.set(path, bytes)
    for (const [path, text] of theme.files) {
        if (path.startsWith('assets/')) bundle.set(`theme/${path.slice('assets/'.length)}`, text)
    }
    if (customCss !== '') bundle.set('theme/custom.css', customCss.endsWith('\n') ? customCss : `${customCss}\n`)
    if (hasMath) {
        const katex = env.katexAssets ? await env.katexAssets() : null
        if (katex) for (const [path, content] of katex) bundle.set(`theme/katex/${path}`, content)
        else warnings.push({ level: 'warning', code: 'katex-assets-unavailable', message: 'The publication has maths but this host has no KaTeX stylesheet to copy in - formulas will render unstyled.' })
    }
}

/** Write each page through its layout, and the generated pages: the index, the archives and 404. */
function writeLayouts({ pages, hasHome, hasJournals, hasPostsArchive, publication, nav, pageSummaries, journalSummaries, postSummaries, themeRenderer, viewFor, bundle }: {
    pages: readonly RenderedPage[]
    hasHome: boolean
    hasJournals: boolean
    hasPostsArchive: boolean
    publication: Publication
    nav: NavNode[]
    pageSummaries: PageSummary[]
    journalSummaries: PageSummary[]
    postSummaries: PageSummary[]
    themeRenderer: ReturnType<typeof createThemeRenderer>
    viewFor: (page: RenderedPage | null, extra: Partial<PageView>) => object
    bundle: SiteBundle
}): void {
    for (const page of pages) {
        const layout = page.isHome ? 'home' : page.doc.kind === 'journal' ? 'journal' : 'page'
        bundle.set(page.isHome ? 'index.html' : page.url, themeRenderer.render(layout, viewFor(page, { url: page.isHome ? 'index.html' : page.url })))
    }
    if (!hasHome) {
        bundle.set('index.html', themeRenderer.render('home', viewFor(null, { title: publication.name, titleHtml: escapeHtml(publication.name), url: 'index.html', isHome: true, isGeneratedIndex: true, content: indexHtml(nav, pageSummaries) })))
    }
    if (hasJournals) {
        bundle.set('journal.html', themeRenderer.render('archive', viewFor(null, { title: 'Journal', titleHtml: 'Journal', url: 'journal.html', isArchive: true, isJournalArchive: true, content: archiveHtml(journalSummaries) })))
    }
    if (hasPostsArchive) {
        bundle.set('posts.html', themeRenderer.render('archive', viewFor(null, { title: 'Posts', titleHtml: 'Posts', url: 'posts.html', isArchive: true, isPostsArchive: true, content: postsArchiveHtml(postSummaries) })))
    }
    bundle.set('404.html', themeRenderer.render('404', viewFor(null, { title: 'Not published', titleHtml: 'Not published', url: '404.html', is404: true, content: '<p class="not-published">This page is not published.</p>' })))
}

/** Say which documents did not get the address they wanted, and why. */
function reportAddresses(
    allocation: ReturnType<typeof allocateSlugs.withReport>,
    homeDoc: PublishDocument | undefined,
    warnings: PublishIssue[],
    info: PublishIssue[],
): void {
    for (const c of allocation.collisions) {
        // A document that asked for an address and did not get it is worth a warning; a derived
        // collision is the normal suffix rule and only information.
        if (c.explicit) {
            warnings.push({ level: 'warning', code: 'slug-taken', message: `"${c.concept}" asks for the address ${c.wanted}.html in its frontmatter, but another document has it - it is at ${c.slug}.html.`, concept: c.concept })
        } else {
            info.push({ level: 'info', code: 'slug-collision', message: `"${c.concept}" wanted the address ${c.wanted}.html, which another document has - it is at ${c.slug}.html.`, concept: c.concept })
        }
    }
    for (const ignoredSlug of allocation.ignored) {
        const why = ignoredSlug.reason === 'reserved' ? 'is a name the site uses for a generated page' : ignoredSlug.reason === 'empty' ? 'leaves nothing once made into an address' : 'is not text'
        warnings.push({ level: 'warning', code: 'slug-ignored', message: `"${ignoredSlug.concept}" has \`slug: ${ignoredSlug.value}\`, which ${why} - its address is derived from its name instead.`, concept: ignoredSlug.concept })
    }
    if (homeDoc && explicitSlugOf(homeDoc.text) !== null) {
        info.push({ level: 'info', code: 'home-slug-ignored', message: `"${homeDoc.concept}" is the home page, so it is index.html whatever its \`slug:\` says.`, concept: homeDoc.concept })
    }
}

/** The pages the publication names for the theme's include slots, where each may be used. */
function includePages(publication: Publication, source: PublishSource, warnings: PublishIssue[]): Map<string, PublishDocument> {
    const includeDocs = new Map<string, PublishDocument>()
    for (const [slot, concept] of Object.entries(publication.includes)) {
        const key = conceptKey(concept)
        const doc = source.documents.find((d) => conceptKey(d.concept) === key || d.aliases.some((a) => conceptKey(a) === key))
        if (!doc) {
            warnings.push({ level: 'warning', code: 'include-page-missing', message: `The include "${slot}" names "${concept}", which is not a document in this graph - the theme's own ${slot} is used.` })
            continue
        }
        // The same consent rule as for a page: an include's body reaches the site, so the page
        // must say public and, for a named publication, name it (2026-09-19). The theme's own
        // partial stands in until it does, and the report says which.
        const status = includeStatus(doc, publication)
        if (status !== 'ok') {
            const why = {
                protected: 'is a protected document and cannot be read',
                'publication-page': 'is a publication page, which is never published',
                'not-public': 'is not public (its frontmatter needs `public: true`)',
                'not-named': `does not name this publication (its frontmatter needs \`publications: [${publication.id}]\`)`,
            }[status]
            warnings.push({ level: 'warning', code: `include-page-${status}`, message: `The include "${slot}" names "${concept}", which ${why} - the theme's own ${slot} is used.` })
            continue
        }
        includeDocs.set(slot, doc)
    }
    return includeDocs
}

/** What the pre-render pass made, each keyed as the renderer asks for it. */
interface Prerendered {
    mermaidSvg: Map<string, string>
    mapPictures: Map<string, MapPicture & { path: string; alt: string }>
    /** What each fence an extension publishes becomes, by its info word and body; null when it is left out. */
    fenceOutputs: Map<string, FenceOutputRef | null>
    /** The pictures extensions made of fences, by their path in the site. */
    fencePictures: Map<string, Uint8Array>
    highlighted: Map<string, string>
}

interface Fence {
    lang: string
    code: string
}

/**
 * The pre-render pass over every body that will be rendered: what each extension fence becomes,
 * the diagrams, the maps and the highlighted code. A map that cannot be drawn is an error.
 */
async function prerenderFences(
    bodies: ReadonlyArray<{ doc: PublishDocument; body: string }>,
    probe: DocumentRenderer,
    env: PublishEnvironment,
    warnings: PublishIssue[],
    errors: PublishIssue[],
): Promise<Prerendered> {
    const made: Prerendered = {
        mermaidSvg: new Map(),
        mapPictures: new Map(),
        fenceOutputs: new Map(),
        fencePictures: new Map(),
        highlighted: new Map(),
    }
    const highlight = env.highlightCode ?? defaultHighlight
    for (const { doc, body } of bodies) {
        for (const fence of probe.fences(body)) {
            if (await settleExtensionFence(fence, doc, env, made, warnings)) continue
            if (fence.lang === 'mermaid') await drawDiagram(fence.code, doc, env, made, warnings)
            else if (fence.lang === MAP_FENCE_INFO) await drawMap(fence.code, doc, env, made, errors)
            else if (fence.lang !== '' && fence.lang !== 'math' && fence.lang !== 'etherpk-cipher') {
                const key = `${fence.lang}\n${fence.code}`
                if (made.highlighted.has(key)) continue
                const html = await highlight(fence.lang, fence.code)
                if (html !== null) made.highlighted.set(key, html)
            }
        }
    }
    return made
}

/**
 * Whether `fence` is settled as an extension's: met before, published by the extension, or an
 * extension fence nothing here can draw. A fence the extension could not make, and any ordinary
 * fence, is left to the rest of the pass.
 */
async function settleExtensionFence(
    fence: Fence,
    doc: PublishDocument,
    env: PublishEnvironment,
    made: Prerendered,
    warnings: PublishIssue[],
): Promise<boolean> {
    const fenceKey = `${fence.lang}\n${fence.code}`
    if (made.fenceOutputs.has(fenceKey)) return true
    const asked = fence.lang === '' ? undefined : env.publishFence?.({ info: fence.lang, body: bodyLines(fence.code), document: doc.concept })
    if (asked) {
        const output = await publishedFence(asked, fence.lang, doc.concept, made.fencePictures, warnings)
        // Undefined: it could not be made, and an ordinary fence falls through to code.
        if (output !== undefined) {
            made.fenceOutputs.set(fenceKey, output)
            return true
        }
    }
    if (!isExtensionFenceInfo(fence.lang)) return false
    // Nothing here draws it (the Headless Client, or its extension off): left out and said, never
    // printed, since its body is the extension's data (ADR 0138).
    made.fenceOutputs.set(fenceKey, null)
    warnings.push({
        level: 'warning',
        code: 'extension-fence-left-out',
        message: `"${doc.concept}" holds content from the ${extensionOfFence(fence.lang)} extension, which this publisher can't draw, so it is left out. Publish from EtherPK in a browser, with that extension on, to include it.`,
        concept: doc.concept,
    })
    return true
}

/** Draw a Mermaid diagram once per source. A diagram that fails is left as its source, with a warning. */
async function drawDiagram(code: string, doc: PublishDocument, env: PublishEnvironment, made: Prerendered, warnings: PublishIssue[]): Promise<void> {
    if (!env.renderMermaid || made.mermaidSvg.has(code)) return
    try {
        made.mermaidSvg.set(code, await env.renderMermaid(code))
    } catch (error) {
        warnings.push({ level: 'warning', code: 'mermaid-render-failed', message: `A diagram in "${doc.concept}" could not be rendered: ${error instanceof Error ? error.message : String(error)}. It is left as its source for a script to draw.`, concept: doc.concept })
    }
}

/** Draw a map once per source. A map that cannot be drawn is an error, once per document. */
async function drawMap(code: string, doc: PublishDocument, env: PublishEnvironment, made: Prerendered, errors: PublishIssue[]): Promise<void> {
    if (made.mapPictures.has(code) || errors.some((e) => e.code === 'map-not-drawn' && e.concept === doc.concept)) return
    if (!env.renderMap) {
        errors.push({ level: 'error', code: 'map-not-drawn', message: `"${doc.concept}" holds a map, which this publisher can't draw. Publish the site from EtherPK in a browser, where maps are drawn.`, concept: doc.concept })
        return
    }
    try {
        const picture = await env.renderMap(code)
        const path = `maps/${await mapPictureName(code)}.${picture.type === 'image/webp' ? 'webp' : 'png'}`
        made.mapPictures.set(code, { ...picture, path, alt: mapAltText(code.split('\n')) })
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        errors.push({ level: 'error', code: 'map-not-drawn', message: `The map in "${doc.concept}" could not be drawn: ${why}. Nothing was published, so try again once it can be.`, concept: doc.concept })
    }
}

/** Render the include pages into the theme's slots, and gather the stylesheet ones' CSS. */
function renderIncludes(
    includeDocs: ReadonlyMap<string, PublishDocument>,
    theme: ThemeFiles,
    renderer: DocumentRenderer,
    scopeDiagrams: (prefix: string) => void,
    warnings: PublishIssue[],
    report: PublishReport,
): { includes: Map<string, string>; customCss: string } {
    const includes = new Map<string, string>()
    let customCss = ''
    const cssSlots = new Set(theme.manifest.includes.filter((s) => s.kind === 'css').map((s) => s.name))
    const knownSlots = new Set(theme.manifest.includes.map((s) => s.name))
    for (const [slot, doc] of includeDocs) {
        if (!knownSlots.has(slot)) {
            warnings.push({ level: 'warning', code: 'include-unknown-slot', message: `The theme "${theme.manifest.name}" has no include slot "${slot}" - the page "${doc.concept}" is not used.` })
            continue
        }
        const body = bodyOf(doc)
        if (cssSlots.has(slot)) {
            const fence = renderer.fences(body).find((f) => f.lang === 'css')
            if (!fence) {
                warnings.push({ level: 'warning', code: 'include-no-css', message: `The include "${slot}" names "${doc.concept}", which has no \`css\` fence - nothing is appended to the stylesheet.` })
                continue
            }
            customCss += (customCss ? '\n' : '') + fence.code
        } else {
            scopeDiagrams(`mermaid__${slot}`)
            includes.set(slot, renderer.render(body).html)
        }
        report.includes.push({ name: slot, source: 'page', concept: doc.concept })
    }
    for (const slot of theme.manifest.includes) {
        if (!includes.has(slot.name) && !(slot.kind === 'css' && customCss !== '')) report.includes.push({ name: slot.name, source: 'theme' })
    }
    return { includes, customCss }
}

/** Copy each asset a rendered document or include references, and report the ones the graph lacks. */
async function copyReferencedAssets(
    pages: readonly RenderedPage[],
    includeDocs: ReadonlyMap<string, PublishDocument>,
    renderer: DocumentRenderer,
    source: PublishSource,
    bundle: SiteBundle,
    report: PublishReport,
    warnings: PublishIssue[],
    progress: (phase: PublishProgress['phase'], done: number, total: number) => void,
): Promise<void> {
    const wanted = new Map<string, string>()
    for (const page of pages) for (const name of page.rendered.assets) if (!wanted.has(name)) wanted.set(name, page.doc.concept)
    for (const [, doc] of includeDocs) for (const name of renderer.render(bodyOf(doc)).assets) if (!wanted.has(name)) wanted.set(name, doc.concept)
    let assetsDone = 0
    for (const [name, from] of wanted) {
        progress('assets', assetsDone++, wanted.size)
        // Encoded again: the source decodes a reference once, and `name` is already decoded, so a
        // literal "%2F" in a name must not become a separator on the way back.
        const asset = await source.readAsset(`../assets/${encodeURIComponent(name)}`)
        if (!asset) {
            report.assets.missing.push({ name, from })
            warnings.push({ level: 'warning', code: 'asset-missing', message: `"${from}" references ${name}, which the graph does not hold - the link is left as it is.`, concept: from })
            continue
        }
        bundle.set(`assets/${name}`, asset.bytes)
        report.assets.copied.push(name)
    }
}

/** The search index, and for a site with a `url` its sitemap and feed, from the rendered pages alone. */
function writeDerivedFiles(
    pages: readonly RenderedPage[],
    dated: readonly RenderedPage[],
    publication: Publication,
    hasJournals: boolean,
    hasPostsArchive: boolean,
    bundle: SiteBundle,
    info: PublishIssue[],
): void {
    const search: SearchEntry[] = pages.map((p) => ({
        slug: p.isHome ? 'index' : p.slug,
        url: p.isHome ? 'index.html' : p.url,
        title: p.title,
        kind: p.doc.kind,
        ...(p.date ? { date: p.date } : {}),
        excerpt: p.rendered.excerpt,
        text: p.rendered.text,
    }))
    bundle.set('search.json', searchIndexJson(search))
    bundle.set('search-index.js', searchIndexScript(search))
    if (publication.url) {
        const entries: SitemapEntry[] = [{ url: 'index.html' }, ...pages.filter((p) => !p.isHome).map((p) => ({ url: p.url, ...(p.date ? { lastmod: p.date } : {}) }))]
        if (hasJournals) entries.push({ url: 'journal.html' })
        if (hasPostsArchive) entries.push({ url: 'posts.html' })
        bundle.set('sitemap.xml', sitemapXml(publication.url, entries))
        if (dated.length > 0) {
            const items: FeedItem[] = dated.map((p) => ({ title: p.title, url: p.isHome ? 'index.html' : p.url, date: p.date as string, description: p.rendered.excerpt }))
            bundle.set('feed.xml', feedXml(publication.url, publication.name, items))
        }
    } else {
        info.push({ level: 'info', code: 'no-site-url', message: 'The publication has no `url`, so no sitemap or feed is written - add one to the publication page to get both.' })
    }
}

/** What the site loads from elsewhere: from the includes, the theme's files and the custom CSS. */
function externalResourcesOf(includes: ReadonlyMap<string, string>, theme: ThemeFiles, customCss: string): string[] {
    const external = new Set<string>()
    for (const html of includes.values()) for (const r of externalResources(html)) external.add(r)
    for (const [path, text] of theme.files) if (/\.(html|css)$/.test(path)) for (const r of externalResources(text)) external.add(r)
    if (customCss) for (const r of externalResources(customCss)) external.add(r)
    return [...external]
}

/** What `pageViewFor` reads besides the page: the site as a whole, its menu and its lists. */
interface ViewContext {
    site: object
    nav: NavNode[]
    /** The dated pages, newest first. */
    dated: readonly RenderedPage[]
    resolver: PublicationResolver
    renderer: DocumentRenderer
    pageSummaries: PageSummary[]
    journalSummaries: PageSummary[]
    postSummaries: PageSummary[]
}

/** The view a theme layout renders for `page`, or for a generated page (`page` null) described by `extra`. */
function pageViewFor(context: ViewContext, page: RenderedPage | null, extra: Partial<PageView>): object {
    const { site, nav, dated, resolver, renderer, pageSummaries, journalSummaries, postSummaries } = context
    const url = extra.url ?? page?.url ?? ''
    const navView = navFor(nav, url)
    const backlinks = page ? backlinkViews(page, resolver, renderer) : []
    const words = wordCountOf(page?.rendered.text ?? '')
    // `dated` is newest first, so the entry before this one is the newer post.
    const at = page?.date === undefined ? -1 : dated.indexOf(page)
    const neighbour = (p: RenderedPage | undefined): PostNeighbour | undefined =>
        p ? { title: p.title, url: p.isHome ? 'index.html' : p.url, date: p.date as string } : undefined
    const newer = at > 0 ? neighbour(dated[at - 1]) : undefined
    const older = at >= 0 ? neighbour(dated[at + 1]) : undefined
    const pageView: PageView = {
        title: page?.title ?? '',
        titleHtml: page?.titleHtml ?? '',
        slug: page?.slug ?? '',
        url,
        kind: page?.doc.kind ?? 'page',
        isHome: page?.isHome ?? false,
        isJournal: page?.doc.kind === 'journal',
        isGeneratedIndex: false,
        isArchive: false,
        isPostsArchive: false,
        isJournalArchive: false,
        is404: false,
        date: page?.date,
        hasDate: page?.date !== undefined,
        content: page?.rendered.html ?? '',
        toc: page?.rendered.toc ?? [],
        hasToc: (page?.rendered.toc.length ?? 0) > 0,
        backlinks,
        hasBacklinks: backlinks.length > 0,
        excerpt: page?.rendered.excerpt ?? '',
        hasMath: page?.rendered.hasMath ?? false,
        hasMermaid: page?.rendered.hasMermaid ?? false,
        wordCount: words,
        readingMinutes: readingMinutesOf(words),
        older,
        newer,
        hasOlder: older !== undefined,
        hasNewer: newer !== undefined,
        ...extra,
    }
    const fragments = {
        nav: navHtml(navView),
        toc: tocHtml(pageView.toc),
        backlinks: backlinksHtml(backlinks),
        index: indexHtml(nav, pageSummaries),
        archive: archiveHtml(journalSummaries),
        posts: postsArchiveHtml(postSummaries),
    }
    return { site, page: pageView, nav: navView, fragments }
}

interface PageView {
    title: string
    titleHtml: string
    slug: string
    url: string
    kind: 'page' | 'journal'
    isHome: boolean
    isJournal: boolean
    isGeneratedIndex: boolean
    /** A generated archive: the journal's (`isJournalArchive`) or the posts' (`isPostsArchive`). */
    isArchive: boolean
    isPostsArchive: boolean
    isJournalArchive: boolean
    is404: boolean
    date?: string
    hasDate: boolean
    content: string
    toc: TocItem[]
    hasToc: boolean
    backlinks: BacklinkView[]
    hasBacklinks: boolean
    excerpt: string
    hasMath: boolean
    hasMermaid: boolean
    /** Words in the rendered text, and the minutes a reader needs at 200 a minute (never 0). */
    wordCount: number
    readingMinutes: number
    /** The dated documents either side of this one, newest first: what a blog's "previous / next" links. */
    older?: PostNeighbour
    newer?: PostNeighbour
    hasOlder: boolean
    hasNewer: boolean
}

interface PostNeighbour {
    title: string
    url: string
    date: string
}

/** A blog reads at about 200 words a minute; a page is never "0 min". */
function readingMinutesOf(words: number): number {
    return Math.max(1, Math.ceil(words / 200))
}

function wordCountOf(text: string): number {
    return text.split(/\s+/).filter((w) => w.length > 0).length
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The links a document makes that point at the 404 page, for the report, spelt as authored. */
function linksOf(body: string, resolver: PublicationResolver, doc: PublishDocument): MissingLink[] {
    const out: MissingLink[] = []
    const seen = new Set<string>()
    for (const occurrence of wikilinkOccurrencesInSource(body)) {
        const key = conceptKey(occurrence.concept)
        if (seen.has(key)) continue
        const target = resolver.resolve(occurrence.concept)
        if (!target.missing) continue
        seen.add(key)
        const link: MissingLink = {
            from: doc.concept,
            concept: target.status === 'missing' ? occurrence.concept : target.canonical,
            status: target.status === 'published' ? 'missing' : target.status,
        }
        if (target.publishedIn) link.publishedIn = target.publishedIn
        out.push(link)
    }
    return out
}

/** The publication's documents that link to `page`, with each linking line rendered inline. */
function backlinkViews(page: RenderedPage, resolver: PublicationResolver, renderer: DocumentRenderer): BacklinkView[] {
    const groups = backlinksFor(resolver.index, page.doc.concept)
    const out: BacklinkView[] = []
    for (const group of groups) {
        if (conceptKey(group.sourceConcept) === conceptKey(page.doc.concept)) continue
        const target = resolver.resolve(group.sourceConcept)
        if (target.missing) continue
        out.push({
            title: titleText(group.sourceConcept),
            titleHtml: resolver.titleHtml(group.sourceConcept),
            url: target.href,
            kind: group.sourceKind,
            refs: group.refs.map((r) => ({ contextHtml: renderer.renderInline(r.lineText.trim().replace(/^-\s+(\[[ xX]\]\s*)?/, '')) })),
        })
    }
    return out
}

export type { NavViewNode }
