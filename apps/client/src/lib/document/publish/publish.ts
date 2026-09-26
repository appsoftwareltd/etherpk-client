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
import { type DocumentRenderer, type RenderedDocument, type TocItem, createDocumentRenderer } from './markdown/render'
import { type NavNode, buildNav } from './nav'
import { discoverPublications } from './publication'
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
    now?(): Date
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

const DATE = /^\d{4}-\d{2}-\d{2}$/

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
            message: `The home page "${publication.home}" is not in this publication; the front page lists the published pages instead.`,
        })
    }
    const allocation = allocateSlugs.withReport(included.filter((d) => d !== homeDoc))
    const slugs = new Map(allocation.slugs)
    if (homeDoc) slugs.set(conceptKey(homeDoc.concept), 'index')
    report.collisions = allocation.collisions
    for (const c of allocation.collisions) {
        // A document that asked for an address and did not get it is worth a warning; a derived
        // collision is the normal suffix rule and only information.
        if (c.explicit) {
            warnings.push({ level: 'warning', code: 'slug-taken', message: `"${c.concept}" asks for the address ${c.wanted}.html in its frontmatter, but another document has it; it is at ${c.slug}.html.`, concept: c.concept })
        } else {
            info.push({ level: 'info', code: 'slug-collision', message: `"${c.concept}" wanted the address ${c.wanted}.html, which another document has; it is at ${c.slug}.html.`, concept: c.concept })
        }
    }
    for (const ignoredSlug of allocation.ignored) {
        const why = ignoredSlug.reason === 'reserved' ? 'is a name the site uses for a generated page' : ignoredSlug.reason === 'empty' ? 'leaves nothing once made into an address' : 'is not text'
        warnings.push({ level: 'warning', code: 'slug-ignored', message: `"${ignoredSlug.concept}" has \`slug: ${ignoredSlug.value}\`, which ${why}; its address is derived from its name instead.`, concept: ignoredSlug.concept })
    }
    if (homeDoc && explicitSlugOf(homeDoc.text) !== null) {
        info.push({ level: 'info', code: 'home-slug-ignored', message: `"${homeDoc.concept}" is the home page, so it is index.html whatever its \`slug:\` says.`, concept: homeDoc.concept })
    }
    const publishedElsewhere = new Map<string, string[]>()
    for (const e of selection.excluded) if (e.publishedIn) publishedElsewhere.set(conceptKey(e.concept), e.publishedIn)
    const resolver = createPublicationResolver({ included, allDocuments: source.documents, slugs, publishedElsewhere })

    // 3. The theme, early: a theme that cannot render is the one error worth stopping for.
    let loaded: LoadedTheme
    try {
        loaded = await env.loadTheme(publication.theme)
    } catch (error) {
        errors.push({ level: 'error', code: 'theme-unavailable', message: error instanceof Error ? error.message : String(error) })
        return { bundle, report }
    }
    const theme = loaded.theme
    report.theme = { source: loaded.source, name: theme.manifest.name, version: theme.manifest.version }
    for (const message of themeFileErrors(theme)) errors.push({ level: 'error', code: 'theme-invalid', message })
    if (errors.length > 0) return { bundle, report }
    if (theme.manifest.contract < THEME_CONTRACT) {
        warnings.push({ level: 'warning', code: 'theme-older-contract', message: `The theme "${theme.manifest.name}" was written for view contract ${theme.manifest.contract}; this EtherPK writes contract ${THEME_CONTRACT}. It is rendered as is; newer view fields are simply absent to it.` })
    }
    if (!theme.manifest.kinds.includes(publication.kind)) {
        warnings.push({ level: 'warning', code: 'theme-kind-mismatch', message: `The theme "${theme.manifest.name}" is made for ${theme.manifest.kinds.join(' and ')} publications; this one is ${publication.kind}.` })
    }

    // 4. The pre-render pass: diagrams and code, over every body that will be rendered.
    const includeDocs = new Map<string, PublishDocument>()
    for (const [slot, concept] of Object.entries(publication.includes)) {
        const key = conceptKey(concept)
        const doc = source.documents.find((d) => conceptKey(d.concept) === key || d.aliases.some((a) => conceptKey(a) === key))
        if (!doc) {
            warnings.push({ level: 'warning', code: 'include-page-missing', message: `The include "${slot}" names "${concept}", which is not a document in this graph; the theme's own ${slot} is used.` })
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
            warnings.push({ level: 'warning', code: `include-page-${status}`, message: `The include "${slot}" names "${concept}", which ${why}; the theme's own ${slot} is used.` })
            continue
        }
        includeDocs.set(slot, doc)
    }
    const mermaidSvg = new Map<string, string>()
    const highlighted = new Map<string, string>()
    const highlight = env.highlightCode ?? defaultHighlight
    const probe = createDocumentRenderer({ resolve: resolver.resolve, assetHref: assetHrefOf })
    const bodies = [...included, ...includeDocs.values()].map((d) => ({ doc: d, body: bodyOf(d) }))
    for (const { doc, body } of bodies) {
        for (const fence of probe.fences(body)) {
            if (fence.lang === 'mermaid') {
                if (!env.renderMermaid || mermaidSvg.has(fence.code)) continue
                try {
                    mermaidSvg.set(fence.code, await env.renderMermaid(fence.code))
                } catch (error) {
                    warnings.push({ level: 'warning', code: 'mermaid-render-failed', message: `A diagram in "${doc.concept}" could not be rendered: ${error instanceof Error ? error.message : String(error)}. It is left as its source for a script to draw.`, concept: doc.concept })
                }
            } else if (fence.lang !== '' && fence.lang !== 'math' && fence.lang !== 'etherpk-cipher') {
                const key = `${fence.lang}\n${fence.code}`
                if (highlighted.has(key)) continue
                const html = await highlight(fence.lang, fence.code)
                if (html !== null) highlighted.set(key, html)
            }
        }
    }
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
    })

    // 5. Render every document.
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
            const date = parseFrontmatter(doc.text).data.date
            if (date !== undefined) {
                const text = date instanceof Date ? date.toISOString().slice(0, 10) : String(date)
                if (DATE.test(text)) page.date = text
                else warnings.push({ level: 'warning', code: 'invalid-date', message: `"${doc.concept}" has \`date: ${String(date)}\`, which is not a calendar day (YYYY-MM-DD); the document is undated.`, concept: doc.concept })
            }
        }
        for (const link of linksOf(bodyOf(doc), resolver, doc)) report.missingLinks.push(link)
        pages.push(page)
        report.included.push({ concept: doc.concept, kind: doc.kind, slug, url: page.url })
    }
    progress('rendering', included.length, included.length)

    // 6. Navigation and the include pages.
    const navResult = buildNav(publication.outline, resolver)
    take(navResult.issues)
    const journals = pages.filter((p) => p.doc.kind === 'journal').sort((a, b) => b.doc.concept.localeCompare(a.doc.concept))
    const plainPages = pages.filter((p) => p.doc.kind === 'page' && !p.isHome).sort((a, b) => conceptKey(a.title).localeCompare(conceptKey(b.title)))
    let nav: NavNode[] = navResult.nav
    if (nav.length === 0) {
        // No outline: a docs site's menu is every page; a blog's is only its undated pages (an
        // About, a Contact), because its posts are the front page and posts.html, and a menu
        // of every post is a header thirty lines deep.
        const menuPages = publication.kind === 'blog' ? plainPages.filter((p) => p.date === undefined) : plainPages
        nav = menuPages.map((p) => ({ label: p.title, labelHtml: p.titleHtml, href: p.url, concept: p.doc.concept, children: [] }))
    }
    if (journals.length > 0 && !nav.some((n) => n.href === 'journal.html')) {
        nav = [...nav, { label: 'Journal', labelHtml: 'Journal', href: 'journal.html', children: [] }]
    }

    const includes = new Map<string, string>()
    let customCss = ''
    const cssSlots = new Set(theme.manifest.includes.filter((s) => s.kind === 'css').map((s) => s.name))
    const knownSlots = new Set(theme.manifest.includes.map((s) => s.name))
    for (const [slot, doc] of includeDocs) {
        if (!knownSlots.has(slot)) {
            warnings.push({ level: 'warning', code: 'include-unknown-slot', message: `The theme "${theme.manifest.name}" has no include slot "${slot}"; the page "${doc.concept}" is not used.` })
            continue
        }
        const body = bodyOf(doc)
        if (cssSlots.has(slot)) {
            const fence = renderer.fences(body).find((f) => f.lang === 'css')
            if (!fence) {
                warnings.push({ level: 'warning', code: 'include-no-css', message: `The include "${slot}" names "${doc.concept}", which has no \`css\` fence; nothing is appended to the stylesheet.` })
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

    // 7. The view and the theme.
    const themeRenderer = createThemeRenderer(theme, includes)
    const hasMath = pages.some((p) => p.rendered.hasMath) || [...includes.values()].some((h) => h.includes('class="katex"'))
    const summaries = (list: RenderedPage[]): PageSummary[] =>
        list.map((p) => ({ title: p.title, titleHtml: p.titleHtml, url: p.url, kind: p.doc.kind, ...(p.date ? { date: p.date } : {}), excerpt: p.rendered.excerpt }))
    const pageSummaries = summaries(plainPages)
    // The pages that are not posts: what a blog's sidebar lists beside its years (About,
    // Contact), where listing every dated page again would double the archive.
    const undatedPageSummaries = summaries(plainPages.filter((p) => p.date === undefined))
    const journalSummaries = summaries(journals)
    const dated = pages.filter((p) => p.date !== undefined).sort((a, b) => (b.date as string).localeCompare(a.date as string))
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
        generatedAt,
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

    function viewFor(page: RenderedPage | null, extra: Partial<PageView>): object {
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

    progress('writing', 0, pages.length + 3)
    for (const page of pages) {
        const layout = page.isHome ? 'home' : page.doc.kind === 'journal' ? 'journal' : 'page'
        bundle.set(page.isHome ? 'index.html' : page.url, themeRenderer.render(layout, viewFor(page, { url: page.isHome ? 'index.html' : page.url })))
    }
    if (!homeDoc) {
        bundle.set('index.html', themeRenderer.render('home', viewFor(null, { title: publication.name, titleHtml: escapeHtml(publication.name), url: 'index.html', isHome: true, isGeneratedIndex: true, content: indexHtml(nav, pageSummaries) })))
    }
    if (journals.length > 0) {
        bundle.set('journal.html', themeRenderer.render('archive', viewFor(null, { title: 'Journal', titleHtml: 'Journal', url: 'journal.html', isArchive: true, isJournalArchive: true, content: archiveHtml(journalSummaries) })))
    }
    if (hasPostsArchive) {
        bundle.set('posts.html', themeRenderer.render('archive', viewFor(null, { title: 'Posts', titleHtml: 'Posts', url: 'posts.html', isArchive: true, isPostsArchive: true, content: postsArchiveHtml(postSummaries) })))
    }
    bundle.set('404.html', themeRenderer.render('404', viewFor(null, { title: 'Not published', titleHtml: 'Not published', url: '404.html', is404: true, content: '<p class="not-published">This page is not published.</p>' })))

    // 8. Assets: reachable from a rendered document or an include, and nothing else.
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
            warnings.push({ level: 'warning', code: 'asset-missing', message: `"${from}" references ${name}, which the graph does not hold; the link is left as it is.`, concept: from })
            continue
        }
        bundle.set(`assets/${name}`, asset.bytes)
        report.assets.copied.push(name)
    }
    for (const [path, text] of theme.files) {
        if (path.startsWith('assets/')) bundle.set(`theme/${path.slice('assets/'.length)}`, text)
    }
    if (customCss !== '') bundle.set('theme/custom.css', customCss.endsWith('\n') ? customCss : `${customCss}\n`)
    if (hasMath) {
        const katex = env.katexAssets ? await env.katexAssets() : null
        if (katex) for (const [path, content] of katex) bundle.set(`theme/katex/${path}`, content)
        else warnings.push({ level: 'warning', code: 'katex-assets-unavailable', message: 'The publication has maths but this host has no KaTeX stylesheet to copy in; formulas will render unstyled.' })
    }

    // 9. Derived files, from the included documents alone.
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
        if (journals.length > 0) entries.push({ url: 'journal.html' })
        if (hasPostsArchive) entries.push({ url: 'posts.html' })
        bundle.set('sitemap.xml', sitemapXml(publication.url, entries))
        if (dated.length > 0) {
            const items: FeedItem[] = dated.map((p) => ({ title: p.title, url: p.isHome ? 'index.html' : p.url, date: p.date as string, description: p.rendered.excerpt }))
            bundle.set('feed.xml', feedXml(publication.url, publication.name, items))
        }
    } else {
        info.push({ level: 'info', code: 'no-site-url', message: 'The publication has no `url`, so no sitemap or feed is written; add one to the publication page to get both.' })
    }
    bundle.set('.nojekyll', '')

    // 10. What the site loads from elsewhere.
    const external = new Set<string>()
    for (const html of includes.values()) for (const r of externalResources(html)) external.add(r)
    for (const [path, text] of theme.files) if (/\.(html|css)$/.test(path)) for (const r of externalResources(text)) external.add(r)
    if (customCss) for (const r of externalResources(customCss)) external.add(r)
    report.external = [...external]
    if (pages.some((p) => p.rendered.mermaidFallback)) {
        warnings.push({ level: 'warning', code: 'mermaid-not-prerendered', message: 'A diagram was not pre-rendered on this host and is left as its source; publish from the browser, or run `etherpk-mcp publish setup`, to get inline SVG.' })
    }

    progress('writing', pages.length + 3, pages.length + 3)
    report.ok = errors.length === 0
    return { bundle, report }
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
            url: target.href === `${page.slug}.html` ? target.href : target.href,
            kind: group.sourceKind,
            refs: group.refs.map((r) => ({ contextHtml: renderer.renderInline(r.lineText.trim().replace(/^-\s+(\[[ xX]\]\s*)?/, '')) })),
        })
    }
    return out
}

export type { NavViewNode }
