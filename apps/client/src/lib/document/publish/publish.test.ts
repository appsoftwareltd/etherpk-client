import { describe, expect, it } from 'vitest'

import { discoverPublications } from './publication'
import { type LoadedTheme, type PublishEnvironment, publishPublication } from './publish'
import { parseThemeManifest } from './theme/manifest'
import { CIPHER_TEXT, SECRET_BODY, documents, source } from './fixture-graph'
import type { PublishDocument, PublishSource } from './types'

const themeFiles = new Map<string, string>([
    ['layouts/page.html', '<!doctype html><title>{{page.title}} · {{site.title}}</title>{{> head}}<body class="{{page.kind}}">{{> header}}<nav>{{{fragments.nav}}}</nav><main><h1>{{{page.titleHtml}}}</h1>{{{fragments.toc}}}{{{page.content}}}</main>{{{fragments.backlinks}}}{{> footer}}</body>'],
    ['layouts/home.html', '<!doctype html><title>{{site.title}}</title><body class="home">{{#page.isGeneratedIndex}}INDEX{{/page.isGeneratedIndex}}{{{page.content}}}{{> footer}}</body>'],
    ['layouts/archive.html', '<!doctype html><title>Journal</title><body class="archive">{{#site.journals}}<a href="{{url}}">{{title}}</a>{{/site.journals}}</body>'],
    ['layouts/404.html', '<!doctype html><title>404</title><body class="missing">{{{page.content}}}</body>'],
    ['partials/head.html', '{{#site.hasMath}}<link rel="stylesheet" href="theme/katex/katex.min.css">{{/site.hasMath}}{{#site.hasCustomCss}}<link rel="stylesheet" href="theme/custom.css">{{/site.hasCustomCss}}'],
    ['partials/header.html', '<header>{{site.title}}</header>'],
    ['partials/footer.html', '<footer>theme footer</footer>'],
    ['assets/theme.css', 'body{margin:0}'],
])
const manifest = parseThemeManifest(
    JSON.stringify({
        name: 'test-theme',
        version: '1.2.3',
        contract: 1,
        kinds: ['docs'],
        includes: [{ name: 'head' }, { name: 'header' }, { name: 'footer' }, { name: 'styles', kind: 'css' }],
    }),
).manifest!

function environment(overrides: Partial<PublishEnvironment> = {}): PublishEnvironment {
    return {
        loadTheme: async (ref): Promise<LoadedTheme> => {
            if (ref !== 'etherpk-docs') throw new Error(`no theme ${ref}`)
            return { theme: { manifest, files: themeFiles }, source: 'bundled' }
        },
        renderMermaid: async (src) => `<svg data-src="${src.trim()}"></svg>`,
        katexAssets: async () => new Map([['katex.min.css', '.katex{}']]),
        now: () => new Date('2026-09-18T12:00:00Z'),
        ...overrides,
    }
}

const docs = discoverPublications(documents).publications.find((p) => p.id === 'docs')!

describe('publishPublication', () => {
    it('writes the site: one file per document, the home at index.html, and the generated files', async () => {
        const { bundle, report } = await publishPublication(source, docs, environment())
        expect(report.errors).toEqual([])
        expect(report.ok).toBe(true)
        expect([...bundle.keys()].sort()).toEqual(
            [
                '.nojekyll',
                '2026-06-02.html',
                '404.html',
                'assets/chart.png',
                'feed.xml',
                'guide-advanced.html',
                'guide.html',
                'index.html',
                'journal.html',
                'physics.html',
                'search-index.js',
                'search.json',
                'sitemap.xml',
                'theme/custom.css',
                'theme/katex/katex.min.css',
                'theme/theme.css',
            ].sort(),
        )
        expect(bundle.has('welcome.html')).toBe(false)
        expect(bundle.get('index.html')).toContain('Welcome to the docs')
    })

    it('never lets a private or protected document into any file of the site', async () => {
        const { bundle, report } = await publishPublication(source, docs, environment())
        for (const [path, content] of bundle) {
            const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
            expect(text, path).not.toContain(SECRET_BODY)
            expect(text, path).not.toContain(CIPHER_TEXT)
            expect(text, path).not.toContain('Protected Doc')
        }
        expect(bundle.has('secret.html')).toBe(false)
        expect(bundle.has('protected-doc.html')).toBe(false)
        expect(JSON.stringify(report)).not.toContain(CIPHER_TEXT)
        expect(JSON.stringify(report)).not.toContain(SECRET_BODY)
    })

    it('renders the body with every construct and resolves links inside the publication', async () => {
        const { bundle } = await publishPublication(source, docs, environment())
        const guide = bundle.get('guide.html') as string
        expect(guide).toContain('<a href="physics.html" class="wikilink">Phys</a>')
        expect(guide).toContain('<a href="guide.html" class="wikilink">Guide</a><a href="guide-advanced.html" class="wikilink"> Advanced</a>')
        expect(guide).toContain('<a href="404.html" class="wikilink-missing">Secret</a>')
        expect(guide).toContain('<a href="404.html" class="wikilink-missing">Release Notes</a>')
        expect(guide).toContain('<a href="404.html" class="wikilink-missing">Nowhere</a>')
        expect(guide).toContain('<span class="task-tag priority-1">Priority 1</span>')
        expect(guide).toContain('<mark>marked</mark>')
        expect(guide).toContain('class="katex"')
        expect(guide).toContain('<figure class="diagram diagram-mermaid"><svg data-src="graph TD; A-->B;"></svg></figure>')
        expect(guide).toContain('<span class="tok-keyword">const</span>')
        expect(guide).toContain('<img src="assets/chart.png" alt="Chart" style="max-width:min(300px, 100%)">')
        expect(guide).toContain('<h2 id="setup">Setup</h2>')
        expect(guide).toContain('<nav class="toc"><ul><li class="toc-level-2"><a href="#setup">Setup</a></li></ul></nav>')
        expect(guide).toContain('<title>Guide · Docs Site</title>')
        expect(guide).toContain('<link rel="stylesheet" href="theme/katex/katex.min.css">')
    })

    it('renders the navigation from the outline with the current page marked, plus a Journal entry', async () => {
        const { bundle } = await publishPublication(source, docs, environment())
        const guide = bundle.get('guide.html') as string
        expect(guide).toContain('<li class="nav-current"><a href="guide.html">Guide</a><ul class="site-nav-list"><li><a href="guide-advanced.html">')
        expect(guide).toContain('<li class="nav-group"><span>Reference</span><ul class="site-nav-list"><li><a href="physics.html">Physics</a></li></ul></li>')
        expect(guide).toContain('<a href="https://example.com/src" rel="noopener">Source</a>')
        expect(guide).toContain('<li><a href="journal.html">Journal</a></li>')
        expect(guide).toContain('<li><a href="index.html">Welcome</a></li>')
        const advanced = bundle.get('guide-advanced.html') as string
        expect(advanced).toContain('<li class="nav-open"><a href="guide.html">Guide</a><ul class="site-nav-list"><li class="nav-current">')
    })

    it('renders backlinks from the publication only, with the linking line', async () => {
        const { bundle } = await publishPublication(source, docs, environment())
        const guide = bundle.get('guide.html') as string
        expect(guide).toContain('<section class="backlinks"><h2>Linked references</h2>')
        expect(guide).toContain('<a href="2026-06-02.html">2026-06-02</a><ul><li class="backlink-context">day one, see <a href="guide.html" class="wikilink">Guide</a></li></ul>')
        expect(guide).toContain('<a href="index.html">Welcome</a>')
        expect(guide).not.toContain(SECRET_BODY)
        // A scoped source is one anchor with plain text: anchors do not nest, so its chained
        // title anchors would have broken the link (the same rule the nav follows).
        expect(guide).toContain('<a href="guide-advanced.html">Guide Advanced</a>')
        expect(guide).not.toMatch(/<a [^>]*><a /)
    })

    it('fills include slots from pages, appends the styles fence, and ignores an unknown slot', async () => {
        const { bundle, report } = await publishPublication(source, docs, environment())
        const guide = bundle.get('guide.html') as string
        expect(guide).toContain('© 2026 <a href="index.html" class="wikilink">Welcome</a> · <a href="404.html" class="wikilink-missing">Secret</a>')
        expect(guide).not.toContain('theme footer')
        expect(bundle.get('theme/custom.css')).toBe('body { color: red }\n')
        expect(guide).toContain('<link rel="stylesheet" href="theme/custom.css">')
        expect(report.includes).toEqual([
            { name: 'footer', source: 'page', concept: 'Site Footer' },
            { name: 'styles', source: 'page', concept: 'Site Styles' },
            { name: 'head', source: 'theme' },
            { name: 'header', source: 'theme' },
        ])
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'include-unknown-slot' }))
        expect(report.external).toEqual(['https://plausible.io/js/script.js'])
        // The include pages fill their slots and are not pages of their own: nothing at
        // site-footer.html, nothing in search, and the report says what they were used for.
        expect(bundle.has('site-footer.html')).toBe(false)
        expect(bundle.has('site-styles.html')).toBe(false)
        expect(report.excluded.find((e) => e.concept === 'Site Footer')).toEqual({
            concept: 'Site Footer',
            reason: 'include-page',
            includes: [
                { publication: 'docs', slot: 'footer' },
                { publication: 'docs', slot: 'banner' },
            ],
        })
        // A private page named for a slot is refused like any other private content: the
        // theme's own partial is used and the report names the page and the fix.
        expect(guide).not.toContain('noindex')
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'include-page-not-public', message: expect.stringContaining('"Private Head"') }))
        expect(report.warnings.find((w) => w.code === 'include-page-not-public')?.message).toContain('public: true')
    })

    it('reads an empty `date:` as undated, with no warning (ADR 0108)', async () => {
        const dated = source.documents.map((d) => (d.concept === 'Guide' ? { ...d, text: d.text.replace('date: 2026-06-01', 'date:') } : d))
        expect(dated.find((d) => d.concept === 'Guide')?.text).toContain('\ndate:\n')
        const { report } = await publishPublication({ ...source, documents: dated }, docs, environment())
        expect(report.warnings.map((w) => w.code)).not.toContain('invalid-date')
    })

    it('refuses an include page that does not name a named publication, and says which key it needs', async () => {
        const named = source.documents.map((d) => (d.concept === 'Site Footer' ? { ...d, text: d.text.replace('publications: [docs]', 'publications: [blog]') } : d))
        const { bundle, report } = await publishPublication({ ...source, documents: named }, docs, environment())
        expect(bundle.get('guide.html')).toContain('theme footer')
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'include-page-not-named', message: expect.stringContaining('publications: [docs]') }))
        expect(report.includes).toContainEqual({ name: 'footer', source: 'theme' })
    })

    it('reports what was included and excluded and why', async () => {
        const { report } = await publishPublication(source, docs, environment())
        expect(report.included.map((d) => d.url)).toEqual(['index.html', 'guide.html', 'guide-advanced.html', 'physics.html', '2026-06-02.html'])
        const reasons = Object.fromEntries(report.excluded.map((e) => [e.concept, e.reason]))
        expect(reasons).toEqual({
            'Docs Site': 'publication-page',
            Blog: 'publication-page',
            Secret: 'not-public',
            'Protected Doc': 'protected',
            'Release Notes': 'not-named',
            'Site Footer': 'include-page',
            'Site Styles': 'include-page',
            'Private Head': 'not-public',
        })
        expect(report.excluded.find((e) => e.concept === 'Release Notes')?.publishedIn).toEqual(['blog'])
        expect(report.missingLinks).toEqual(
            expect.arrayContaining([
                { from: 'Guide', concept: 'Secret', status: 'private' },
                { from: 'Guide', concept: 'Release Notes', status: 'elsewhere', publishedIn: ['blog'] },
                { from: 'Guide', concept: 'Nowhere', status: 'missing' },
            ]),
        )
        expect(report.assets).toEqual({ copied: ['chart.png'], missing: [{ name: 'gone.png', from: 'Guide' }] })
        expect(report.theme).toEqual({ source: 'bundled', name: 'test-theme', version: '1.2.3' })
        expect(report.publicInNoPublication).toEqual([])
    })

    it('writes the derived files from the included documents alone', async () => {
        const { bundle } = await publishPublication(source, docs, environment())
        const search = JSON.parse(bundle.get('search.json') as string)
        expect(search.documents.map((d: { url: string }) => d.url)).toEqual(['index.html', 'guide.html', 'guide-advanced.html', 'physics.html', '2026-06-02.html'])
        expect(search.documents[1].text).toContain('Install Phys and read Guide Advanced')
        // The same index as a script, for a site opened from disk: file:// blocks fetch, a
        // <script src> it allows (2026-09-19).
        const script = bundle.get('search-index.js') as string
        expect(script.startsWith('window.etherpkSearchIndex=')).toBe(true)
        expect(JSON.parse(script.slice('window.etherpkSearchIndex='.length).replace(/;\n$/, ''))).toEqual(search)
        const sitemap = bundle.get('sitemap.xml') as string
        expect(sitemap).toContain('<loc>https://docs.example.com/index.html</loc>')
        expect(sitemap).toContain('<loc>https://docs.example.com/guide.html</loc>')
        expect(sitemap).not.toContain('secret')
        const feed = bundle.get('feed.xml') as string
        expect(feed).toContain('<link>https://docs.example.com/2026-06-02.html</link>')
        expect(feed).toContain('<link>https://docs.example.com/guide.html</link>')
        expect(feed).toContain('<pubDate>Tue, 02 Jun 2026 00:00:00 GMT</pubDate>')
        expect(bundle.get('journal.html')).toContain('<a href="2026-06-02.html">2026-06-02</a>')
        expect(bundle.get('404.html')).toContain('This page is not published.')
    })

    it('a theme that cannot be loaded is the one error that stops the publish', async () => {
        const { bundle, report } = await publishPublication(source, docs, environment({ loadTheme: async () => { throw new Error('no such theme') } }))
        expect(bundle.size).toBe(0)
        expect(report.ok).toBe(false)
        expect(report.errors).toEqual([expect.objectContaining({ code: 'theme-unavailable', message: 'no such theme' })])
    })

    it('without a browser a diagram stays as its source, and the report says what to do', async () => {
        const { bundle, report } = await publishPublication(source, docs, environment({ renderMermaid: undefined }))
        expect(bundle.get('guide.html')).toContain('<pre class="mermaid">graph TD; A--&gt;B;')
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'mermaid-not-prerendered' }))
    })

    it('gives every drawn diagram an id of its own, the one its styles are scoped to, and the same one on every publish', async () => {
        // Mermaid scopes every rule of a diagram's inline <style> to the id of its root <svg>,
        // and without that id every node rect falls back to SVG's default black fill. The hosts
        // keep it; the publisher renames it to one that is unique on the page and does not depend
        // on the host's render counter.
        const mermaidLike = (id: string, label: string) =>
            `<svg id="${id}" width="100%" class="flowchart"><style>#${id}{font-family:x}#${id} .node rect{fill:#ECECFF}</style><defs><marker id="${id}_flowchart-pointEnd"></marker></defs><g class="node"><rect></rect><path marker-end="url(#${id}_flowchart-pointEnd)"></path><text>${label}</text></g></svg>`
        const hostWithCounter = (start: number) => {
            let n = start
            return environment({ renderMermaid: async (src) => mermaidLike(`gk-mermaid-${++n}`, src.trim()) })
        }
        const withDiagrams = documents.map((d) => {
            // The same diagram twice on one page, and another in the footer every page carries.
            if (d.concept === 'Guide') return { ...d, text: `${d.text}\n\`\`\`mermaid\ngraph TD; A-->B;\n\`\`\`\n\n\`\`\`mermaid\ngraph LR; C-->D;\n\`\`\`\n` }
            if (d.concept === 'Site Footer') return { ...d, text: `${d.text}\n\`\`\`mermaid\ngraph LR; E-->F;\n\`\`\`\n` }
            return d
        })
        const withDiagramsSource = { ...source, documents: withDiagrams }
        const publication = discoverPublications(withDiagrams).publications.find((p) => p.id === 'docs')!

        const first = await publishPublication(withDiagramsSource, publication, hostWithCounter(0))
        const guide = first.bundle.get('guide.html') as string
        const svgs = [...guide.matchAll(/<svg\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/g)]
        // Three in the body (one diagram twice) and one from the footer include.
        expect(svgs).toHaveLength(4)
        const ids = svgs.map((m) => m[1])
        expect(new Set(ids).size).toBe(4)
        for (const [, id, inner] of svgs) {
            // A CSS id selector cannot start with a digit, and journal slugs do.
            expect(id).toMatch(/^[A-Za-z]/)
            const scopes = [...inner.matchAll(/#([A-Za-z][\w-]*)[\s{.]/g)].map((m) => m[1])
            expect(scopes.length).toBeGreaterThan(0)
            for (const scope of scopes) expect(scope).toBe(id)
            expect(inner).toContain(`marker id="${id}_flowchart-pointEnd"`)
            expect(inner).toContain(`url(#${id}_flowchart-pointEnd)`)
            expect(inner).not.toContain('gk-mermaid')
        }

        // A host whose counter has moved on (the editor drew diagrams in between) publishes the
        // same bytes, so an unchanged page is not rewritten.
        const second = await publishPublication(withDiagramsSource, publication, hostWithCounter(40))
        expect(second.bundle.get('guide.html')).toBe(guide)
    })

    it('without a home concept the front page is a generated index shaped like the outline', async () => {
        // The outline is the site's structure, so the index mirrors it - groups and their pages,
        // outside links too - and lists any published page the outline leaves out beneath, so
        // nothing is unreachable from the front page (2026-09-20). The fixture's outline names
        // Welcome, Guide, Guide Advanced, Reference > Physics and an outside Source link.
        const noHome = { ...docs, home: undefined }
        const { bundle, report } = await publishPublication(source, noHome, environment())
        const index = bundle.get('index.html') as string
        expect(index).toContain(
            'INDEX<nav class="page-index" aria-label="Contents"><ul class="page-index-list">' +
                '<li><a href="welcome.html">Welcome</a></li>' +
                '<li><a href="guide.html">Guide</a><ul class="page-index-list"><li><a href="guide-advanced.html">Guide Advanced</a></li></ul></li>' +
                '<li class="page-index-group"><span class="page-index-group-label">Reference</span><ul class="page-index-list"><li><a href="physics.html">Physics</a></li></ul></li>' +
                '<li><a href="https://example.com/src" rel="noopener">Source</a></li>' +
                '<li><a href="journal.html">Journal</a></li>' +
                '</ul></nav>',
        )
        // Every page in the fixture is in the outline, so there is no "other pages" tail.
        expect(index).not.toContain('page-index-other')
        expect(bundle.has('welcome.html')).toBe(true)
        expect(report.warnings.map((w) => w.code)).not.toContain('home-not-published')

        // An outline that leaves pages out: they follow, alphabetically, under a heading. No
        // outline at all: the navigation is every page alphabetically, and so is the index.
        const partial = await publishPublication(source, { ...noHome, outline: '- [[Guide]]\n' }, environment())
        expect(partial.bundle.get('index.html')).toContain(
            '</nav><h2 class="page-index-other">Other pages</h2><ul class="page-index-list"><li><a href="guide-advanced.html">Guide Advanced</a></li><li><a href="physics.html">Physics</a></li><li><a href="welcome.html">Welcome</a></li></ul>',
        )
        const flat = await publishPublication(source, { ...noHome, outline: '' }, environment())
        expect(flat.bundle.get('index.html')).toContain('INDEX<nav class="page-index" aria-label="Contents"><ul class="page-index-list"><li><a href="guide.html">Guide</a></li><li><a href="guide-advanced.html">')
        expect(flat.bundle.get('index.html')).not.toContain('page-index-other')
    })

    it('reports a home page that is not in the publication and falls back to the index', async () => {
        const { bundle, report } = await publishPublication(source, { ...docs, home: 'Secret' }, environment())
        expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'home-not-published' }))
        expect(bundle.get('index.html')).toContain('INDEX')
    })

    it('a document with a slug key takes that address, and every link and derived file follows it', async () => {
        const withSlug = documents.map((d) =>
            d.concept === 'Physics' ? { ...d, text: d.text.replace('aliases: [Phys]', 'aliases: [Phys]\nslug: Physical World') } : d,
        )
        const { bundle, report } = await publishPublication({ ...source, documents: withSlug }, docs, environment())
        expect(bundle.has('physical-world.html')).toBe(true)
        expect(bundle.has('physics.html')).toBe(false)
        expect(bundle.get('guide.html')).toContain('<a href="physical-world.html" class="wikilink">Phys</a>')
        expect(bundle.get('sitemap.xml')).toContain('physical-world.html')
        expect(JSON.parse(bundle.get('search.json') as string).documents.map((d: { url: string }) => d.url)).toContain('physical-world.html')
        expect(report.included.find((d) => d.concept === 'Physics')?.url).toBe('physical-world.html')
    })

    it('gives a page its reading time and, when dated, the posts either side of it', async () => {
        // What a blog theme in the PaperMod mould shows: "3 min" under the title, and previous /
        // next links between dated documents, newest first (2026-09-20).
        const files = new Map([...themeFiles, ['layouts/page.html', '{{page.wordCount}}|{{page.readingMinutes}}|{{#page.older}}older={{title}}@{{url}}{{/page.older}}|{{#page.newer}}newer={{title}}@{{url}}{{/page.newer}}|{{#page.hasOlder}}O{{/page.hasOlder}}{{#page.hasNewer}}N{{/page.hasNewer}}']])
        const { bundle } = await publishPublication(source, docs, environment({ loadTheme: async () => ({ theme: { manifest, files }, source: 'bundled' }) }))
        // Guide is dated 2026-06-01, the journal 2026-06-02: the journal is the newer post, and
        // Guide, the oldest, has nothing older.
        const guide = bundle.get('guide.html') as string
        expect(guide).toMatch(/^\d+\|1\|\|newer=2026-06-02@2026-06-02\.html\|N$/)
        expect(Number(guide.split('|')[0])).toBeGreaterThan(10)
        expect(bundle.get('2026-06-02.html')).toMatch(/^\d+\|1\|older=Guide@guide\.html\|\|O$/)
        // An undated page has neither neighbour.
        expect(bundle.get('physics.html')).toMatch(/^\d+\|1\|\|\|$/)
    })

    it('a blog lists its recent posts on the front page and every post by year on posts.html', async () => {
        // Front pages list the latest few; an archive page carries the lot, grouped by year, so a
        // blog of hundreds of posts never has to page (2026-09-20). Two dated documents here, so
        // `recent: 1` shows the cut.
        const files = new Map([
            ...themeFiles,
            ['layouts/home.html', '{{#site.recentPosts}}[{{title}}]{{/site.recentPosts}}|{{site.postCount}}|{{#site.hasMorePosts}}more@{{site.postsUrl}}{{/site.hasMorePosts}}'],
            ['layouts/archive.html', '{{#page.isPostsArchive}}POSTS{{/page.isPostsArchive}}{{#page.isJournalArchive}}JOURNAL{{/page.isJournalArchive}}|{{#site.postsByYear}}{{year}}:{{#posts}}[{{title}}]{{/posts}};{{/site.postsByYear}}|{{{fragments.posts}}}'],
        ])
        const blog = discoverPublications(documents).publications.find((p) => p.id === 'blog')!
        const { bundle, report } = await publishPublication(
            source,
            { ...blog, selection: 'all-public', recent: 1 },
            environment({ loadTheme: async () => ({ theme: { manifest, files }, source: 'bundled' }) }),
        )
        expect(report.errors).toEqual([])
        expect(bundle.get('index.html')).toBe('[2026-06-02]|2|more@posts.html')
        expect(bundle.get('posts.html')).toMatch(/^POSTS\|2026:\[2026-06-02\]\[Guide\];\|<section class="posts-archive">/)
        expect(bundle.get('posts.html')).toContain('<h2 class="posts-archive-year" id="y2026">2026</h2>')
        expect(bundle.get('journal.html')).toMatch(/^JOURNAL\|/)
        expect(report.included.map((d) => d.url)).not.toContain('posts.html')
        expect(bundle.get('sitemap.xml') ?? '').toBe('')

        // Everything on the front page: no cut, no link. A docs site has no posts archive at all.
        const all = await publishPublication(source, { ...blog, selection: 'all-public' }, environment({ loadTheme: async () => ({ theme: { manifest, files }, source: 'bundled' }) }))
        expect(all.bundle.get('index.html')).toBe('[2026-06-02][Guide]|2|')
        expect(all.bundle.has('posts.html')).toBe(true)
        const docsSite = await publishPublication(source, docs, environment({ loadTheme: async () => ({ theme: { manifest, files }, source: 'bundled' }) }))
        expect(docsSite.bundle.has('posts.html')).toBe(false)
    })

    it('a blog with no outline lists only its undated pages in the navigation, never its posts', async () => {
        // A blog's posts are the front page and posts.html; a menu of every post (a Terminal
        // header with thirty entries) is the docs fallback applied to the wrong kind (2026-09-20).
        const files = new Map([...themeFiles, ['layouts/page.html', '{{#nav}}[{{href}}]{{/nav}}']])
        const blog = discoverPublications(documents).publications.find((p) => p.id === 'blog')!
        const loadTheme = async () => ({ theme: { manifest, files }, source: 'bundled' as const })
        const { bundle, report } = await publishPublication(source, { ...blog, selection: 'all-public', outline: '' }, environment({ loadTheme }))
        expect(report.errors).toEqual([])
        // Guide is dated, so it is a post; the rest are pages, alphabetically, then the Journal.
        expect(bundle.get('physics.html')).toBe('[guide-advanced.html][physics.html][release-notes.html][welcome.html][journal.html]')
        // A docs site with no outline keeps every page, dated or not.
        const docsSite = await publishPublication(source, { ...docs, home: undefined, outline: '' }, environment({ loadTheme }))
        expect(docsSite.bundle.get('physics.html')).toContain('[guide.html][guide-advanced.html]')
    })

    it('reports progress through the phases', async () => {
        const phases: string[] = []
        await publishPublication(source, docs, environment(), { onProgress: (p) => phases.push(p.phase) })
        expect([...new Set(phases)]).toEqual(['selecting', 'rendering', 'writing', 'assets'])
    })
})

describe('asset references that would leave assets/', () => {
    const site: PublishDocument[] = [
        { concept: 'Site', kind: 'page', aliases: [], text: '---\npublication:\n  id: site\n  home: Home\n---\n- [[Home]]\n' },
        {
            concept: 'Home',
            kind: 'page',
            aliases: [],
            text: [
                '---',
                'public: true',
                'publications: [site]',
                '---',
                // Decodes to ../../escape.png: not an asset reference at all.
                '![escape](../assets/..%2F..%2Fescape.png)',
                // Decodes once to a literal name holding "%2F": safe, and must be asked for as
                // exactly that name, not decoded a second time into a/../b.png.
                '![literal](../assets/a%252F..%252Fb.png)',
                '![plain](../assets/fine%20name.png)',
                '',
            ].join('\n'),
        },
    ]

    it('bundles only single-file names, asking the source for each exactly as the store will decode it', async () => {
        const asked: string[] = []
        const recording: PublishSource = {
            documents: site,
            async readAsset(ref) {
                asked.push(ref)
                return { bytes: new Uint8Array([7]), name: 'x', type: 'image/png' }
            },
        }
        const publication = discoverPublications(site).publications.find((p) => p.id === 'site')!
        const { bundle } = await publishPublication(recording, publication, environment())

        const assetKeys = [...bundle.keys()].filter((key) => key.startsWith('assets/'))
        expect(assetKeys.sort()).toEqual(['assets/a%2F..%2Fb.png', 'assets/fine name.png'])
        expect([...bundle.keys()].every((key) => !key.split('/').includes('..'))).toBe(true)
        expect(asked.sort()).toEqual(['../assets/a%252F..%252Fb.png', '../assets/fine%20name.png'])
    })
})

// A fence an extension draws is published as what its `publish` makes of it, a picture or a link,
// and an Extension Fence nothing publishes is left out with a warning, never printed as its data
// (ADR 0138). An ordinary fence nothing publishes is code, as ever.
describe("an extension's fence in a published page", () => {
    const page = (concept: string, text: string): PublishDocument => ({ concept, kind: 'page', text, aliases: [] })
    const fenceDocs = [
        page('Site', '---\npublication:\n  id: site\n---\n- [[Garden]]\n'),
        page(
            'Garden',
            '---\npublic: true\npublications: [site]\n---\nThe plan for the beds.\n\n```garden.plan\n{"id":"k1"}\n{"type":"text","text":"Raised beds"}\n```\n\n```video\nhttps://youtu.be/abcdefghijk\n```\n',
        ),
    ]
    const fenceSource: PublishSource = { documents: fenceDocs, readAsset: async () => null }
    const site = discoverPublications(fenceDocs).publications.find((p) => p.id === 'site')!
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

    it('publishes the picture and the link the extensions made, and none of the data', async () => {
        const asked: string[] = []
        const { bundle, report } = await publishPublication(
            fenceSource,
            site,
            environment({
                publishFence: (fence) => {
                    asked.push(`${fence.info} ${fence.document} ${fence.body.length}`)
                    if (fence.info === 'garden.plan') return Promise.resolve({ kind: 'picture', type: 'image/svg+xml', bytes: svg, width: 640, height: 320, alt: 'Garden plan' })
                    return Promise.resolve({ kind: 'link', href: 'https://www.youtube.com/watch?v=abcdefghijk', text: 'Watch on YouTube', image: { src: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', alt: '' } })
                },
            }),
        )
        expect(report.errors).toEqual([])
        expect(asked).toEqual(['garden.plan Garden 2', 'video Garden 1'])
        const picture = [...bundle.keys()].find((path) => path.startsWith('pictures/'))
        expect(picture).toMatch(/^pictures\/[0-9a-f]{16}\.svg$/)
        const html = bundle.get('garden.html') as string
        expect(html).toContain(`<img src="${picture}" alt="Garden plan" width="640" height="320" loading="lazy">`)
        expect(html).toContain('<a href="https://www.youtube.com/watch?v=abcdefghijk">Watch on YouTube</a>')
        for (const [path, content] of bundle) if (typeof content === 'string') expect(content, path).not.toContain('Raised beds')
    })

    it('leaves out an Extension Fence where nothing publishes it, saying so, and prints an ordinary one as code', async () => {
        const { bundle, report } = await publishPublication(fenceSource, site, environment())
        expect(report.ok).toBe(true)
        expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'extension-fence-left-out', concept: 'Garden' })]))
        const html = bundle.get('garden.html') as string
        expect(html).not.toContain('garden.plan')
        expect(html).toContain('https://youtu.be/abcdefghijk')
        for (const [path, content] of bundle) if (typeof content === 'string') expect(content, path).not.toContain('Raised beds')
    })

    it('refuses a link that is not https, publishing the fence as its text with a warning', async () => {
        const { bundle, report } = await publishPublication(
            fenceSource,
            site,
            environment({ publishFence: (fence) => (fence.info === 'video' ? Promise.resolve({ kind: 'link', href: 'javascript:alert(1)', text: 'Watch' }) : undefined) }),
        )
        expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'extension-fence-failed' })]))
        expect(bundle.get('garden.html')).not.toContain('javascript:')
    })
})

// A Map Block is published as a picture the host draws (ADR 0118), and a map that cannot be drawn
// stops the publish rather than be left out of a page without a word (ADR 0084's rule).
describe('a Map Block in a published page', () => {
    const page = (concept: string, text: string): PublishDocument => ({ concept, kind: 'page', text, aliases: [] })
    const mapDocs = [
        page('Site', '---\npublication:\n  id: site\n---\n- [[Trips]]\n'),
        page('Trips', '---\npublic: true\npublications: [site]\n---\nPlaces we liked.\n\n```map\nPebble Cove @ 50.74860, -4.07890\n```\n'),
    ]
    const mapSource: PublishSource = { documents: mapDocs, readAsset: async () => null }
    const site = discoverPublications(mapDocs).publications.find((p) => p.id === 'site')!
    const drawn = { bytes: new Uint8Array([7, 7, 7]), type: 'image/webp' as const, width: 800, height: 450 }

    it('publishes the picture the host drew, and no coordinate anywhere in the site', async () => {
        const asked: string[] = []
        const { bundle, report } = await publishPublication(mapSource, site, environment({ renderMap: async (source) => (asked.push(source), drawn) }))
        expect(report.errors).toEqual([])
        expect(asked).toEqual(['Pebble Cove @ 50.74860, -4.07890\n'])
        const picture = [...bundle.keys()].find((path) => path.startsWith('maps/'))
        expect(picture).toMatch(/^maps\/[0-9a-f]{16}\.webp$/)
        expect(bundle.get(picture!)).toEqual(drawn.bytes)
        expect(bundle.get('trips.html')).toContain(`<img src="${picture}" alt="Map of Pebble Cove" width="800" height="450" loading="lazy">`)
        for (const [path, content] of bundle) if (typeof content === 'string') expect(content, path).not.toContain('50.7486')
    })

    it('names a picture by what the map holds, so an unchanged map publishes the same file', async () => {
        const first = await publishPublication(mapSource, site, environment({ renderMap: async () => drawn }))
        const again = await publishPublication(mapSource, site, environment({ renderMap: async () => drawn }))
        const pictures = (bundle: Map<string, unknown>) => [...bundle.keys()].filter((path) => path.startsWith('maps/'))
        expect(pictures(first.bundle)).toHaveLength(1)
        expect(pictures(again.bundle)).toEqual(pictures(first.bundle))
    })

    it('stops when the host cannot draw maps, naming the document', async () => {
        const { bundle, report } = await publishPublication(mapSource, site, environment({ renderMap: undefined }))
        expect(report.ok).toBe(false)
        expect(bundle.size).toBe(0)
        expect(report.errors).toEqual([expect.objectContaining({ code: 'map-not-drawn', concept: 'Trips' })])
    })

    it('stops when a map cannot be drawn, naming the document and why', async () => {
        const { bundle, report } = await publishPublication(mapSource, site, environment({ renderMap: async () => Promise.reject(new Error('the map tiles did not load')) }))
        expect(report.ok).toBe(false)
        expect(bundle.size).toBe(0)
        expect(report.errors).toEqual([expect.objectContaining({ code: 'map-not-drawn', concept: 'Trips', message: expect.stringContaining('the map tiles did not load') })])
    })
})

describe('publish contracts', () => {
    /** A theme whose layouts print the view's fields, so a test reads what the publisher decided. */
    const probeFiles = new Map<string, string>([
        [
            'layouts/page.html',
            'PAGE|{{page.slug}}|{{page.kind}}|{{page.url}}|{{#page.isHome}}home{{/page.isHome}}|{{#page.isJournal}}journal{{/page.isJournal}}|{{#page.hasDate}}dated{{/page.hasDate}}|{{#page.hasToc}}toc{{/page.hasToc}}|{{#page.hasBacklinks}}backlinks{{/page.hasBacklinks}}|{{#page.hasMath}}math{{/page.hasMath}}|{{#page.hasMermaid}}mermaid{{/page.hasMermaid}}|{{#page.is404}}404{{/page.is404}}{{#page.isArchive}}archive{{/page.isArchive}}{{#page.isGeneratedIndex}}generated{{/page.isGeneratedIndex}}|{{page.wordCount}}|{{page.readingMinutes}}|{{#nav}}[{{href}}]{{/nav}}|{{{fragments.backlinks}}}|{{{page.content}}}',
        ],
        [
            'layouts/home.html',
            'HOME|{{site.url}}|{{#site.hasUrl}}url{{/site.hasUrl}}|{{#site.isDocs}}docs{{/site.isDocs}}|{{#site.isBlog}}blog{{/site.isBlog}}|{{#site.hasJournals}}journals{{/site.hasJournals}}|{{#site.hasPosts}}posts{{/site.hasPosts}}|{{#site.hasCustomCss}}css{{/site.hasCustomCss}}|{{#site.hasFeed}}feed{{/site.hasFeed}}|{{#site.hasUndatedPages}}undated{{/site.hasUndatedPages}}|{{#site.undatedPages}}({{title}}){{/site.undatedPages}}|{{#page.isGeneratedIndex}}generated{{/page.isGeneratedIndex}}|{{#page.isHome}}home{{/page.isHome}}|{{{page.titleHtml}}}',
        ],
        ['layouts/journal.html', 'JOURNAL|{{page.slug}}'],
        ['partials/head.html', ''],
        ['partials/header.html', ''],
        ['partials/footer.html', ''],
        ['layouts/archive.html', 'ARCHIVE|{{#page.isArchive}}archive{{/page.isArchive}}|{{#site.journals}}({{title}}){{/site.journals}}'],
        [
            'layouts/404.html',
            'MISSING|{{#page.is404}}404{{/page.is404}}|{{#page.isHome}}home{{/page.isHome}}|{{#page.isJournal}}journal{{/page.isJournal}}|{{#page.hasDate}}dated{{/page.hasDate}}|{{#page.hasToc}}toc{{/page.hasToc}}|{{#page.hasBacklinks}}backlinks{{/page.hasBacklinks}}|{{#page.hasMath}}math{{/page.hasMath}}|{{#page.hasMermaid}}mermaid{{/page.hasMermaid}}|{{page.kind}}|{{page.url}}',
        ],
    ])
    const probeManifest: typeof manifest = { ...manifest, kinds: ['docs', 'blog'] }
    const probe = (overrides: Partial<PublishEnvironment> = {}, files: ReadonlyMap<string, string> = probeFiles, themeManifest = probeManifest) =>
        environment({ loadTheme: async () => ({ theme: { manifest: themeManifest, files: new Map(files) }, source: 'bundled' }), ...overrides })

    const pageDoc = (concept: string, body: string, front = 'public: true\npublications: [site]', aliases: string[] = []): PublishDocument => ({
        concept,
        kind: 'page',
        text: `---\n${front}\n---\n${body}`,
        aliases,
    })
    const journalDoc = (day: string, body: string): PublishDocument => ({ concept: day, kind: 'journal', text: `---\npublic: true\npublications: [site]\n---\n${body}`, aliases: [] })
    /** A graph of `documents` under a publication page `Site` whose frontmatter adds `keys`. */
    function site(keys: string, docsOfSite: PublishDocument[], readAsset: PublishSource['readAsset'] = async () => null) {
        const all: PublishDocument[] = [{ concept: 'Site', kind: 'page', aliases: [], text: `---\npublication:\n  id: site\n${keys}---\n` }, ...docsOfSite]
        const publication = discoverPublications(all).publications.find((p) => p.id === 'site')!
        return { source: { documents: all, readAsset } as PublishSource, publication }
    }
    const text = (value: string | Uint8Array | undefined) => (typeof value === 'string' ? value : value === undefined ? '' : new TextDecoder().decode(value))

    describe('the report', () => {
        it('starts every list empty and names the publication', async () => {
            const { source: s, publication } = site('  home: Garden\n  url: https://garden.example.com/\n', [pageDoc('Garden', '- water the beans\n')])
            const { report } = await publishPublication(s, publication, probe())
            expect(report.publication).toEqual({ id: 'site', name: publication.name, kind: 'docs', theme: publication.theme })
            expect(report.errors).toEqual([])
            expect(report.warnings).toEqual([])
            expect(report.info).toEqual([])
            expect(report.excluded).toEqual([expect.objectContaining({ concept: 'Site' })])
            expect(report.collisions).toEqual([])
            expect(report.missingLinks).toEqual([])
            expect(report.external).toEqual([])
            expect(report.publicInNoPublication).toEqual([])
            expect(report.ok).toBe(true)
        })

        it('sorts each issue by its level, and fails a publish that holds an error', async () => {
            const { source: s, publication } = site('', [pageDoc('Garden', '- water the beans\n', 'public: true\npublications: [site]\ndate: someday')])
            const dated = await publishPublication(s, publication, probe())
            expect(dated.report.warnings).toEqual([expect.objectContaining({ code: 'invalid-date', concept: 'Garden' })])
            expect(dated.report.errors).toEqual([])

            const duplicate: PublishDocument = { concept: 'Other Site', kind: 'page', aliases: [], text: '---\npublication:\n  id: site\n---\n' }
            const { report } = await publishPublication({ ...s, documents: [...s.documents, duplicate] }, publication, probe())
            expect(report.errors).toContainEqual(expect.objectContaining({ code: 'publication-duplicate-id' }))
            expect(report.warnings.map((w) => w.code)).not.toContain('publication-duplicate-id')
            expect(report.ok).toBe(false)
        })

        it('lists a public page that no publication takes', async () => {
            const { source: s, publication } = site('', [pageDoc('Garden', '- beans\n'), pageDoc('Kitchen', '- bread\n', 'public: true\npublications: [elsewhere]')])
            const { report } = await publishPublication(s, publication, probe())
            expect(report.publicInNoPublication).toEqual(['Kitchen'])
        })

        it('reports progress totals for rendering and writing', async () => {
            const { source: s, publication } = site('', [pageDoc('Garden', '- beans\n'), pageDoc('Kitchen', '- bread\n')])
            const seen: Array<{ phase: string; done: number; total: number }> = []
            await publishPublication(s, publication, probe(), { onProgress: (p) => seen.push(p) })
            expect(seen.filter((p) => p.phase === 'rendering')).toEqual([
                { phase: 'rendering', done: 0, total: 2 },
                { phase: 'rendering', done: 1, total: 2 },
                { phase: 'rendering', done: 2, total: 2 },
            ])
            expect(seen.filter((p) => p.phase === 'writing')).toEqual([
                { phase: 'writing', done: 0, total: 5 },
                { phase: 'writing', done: 5, total: 5 },
            ])
        })

        it('names a missing link once, by the private page’s own name, and skips links that resolve', async () => {
            const { source: s, publication } = site('', [
                pageDoc('Garden', '- [[Barn]] and [[Barn]], [[Nowhere]] and [[nowhere]], [[Kitchen]]\n'),
                pageDoc('Kitchen', '- bread\n'),
                pageDoc('Shed', '- tools\n', 'title: Shed', ['Barn']),
            ])
            const { report } = await publishPublication(s, publication, probe())
            expect(report.missingLinks).toEqual([
                { from: 'Garden', concept: 'Shed', status: 'private' },
                { from: 'Garden', concept: 'Nowhere', status: 'missing' },
            ])
        })
    })

    describe('the theme', () => {
        it('stops on a theme whose files are invalid', async () => {
            const files = new Map([...probeFiles].filter(([path]) => path !== 'layouts/page.html'))
            const { bundle, report } = await publishPublication(source, docs, probe({}, files))
            expect(bundle.size).toBe(0)
            expect(report.ok).toBe(false)
            expect(report.errors.map((e) => e.code)).toContain('theme-invalid')
        })

        it('warns about a theme written for an older contract or another kind of publication', async () => {
            const older = await publishPublication(source, docs, probe({}, probeFiles, { ...probeManifest, contract: 0, kinds: ['blog'] }))
            expect(older.report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['theme-older-contract', 'theme-kind-mismatch']))
            const current = await publishPublication(source, docs, probe())
            expect(current.report.warnings.map((w) => w.code)).not.toContain('theme-older-contract')
            expect(current.report.warnings.map((w) => w.code)).not.toContain('theme-kind-mismatch')
        })

        it('reports every outside resource the theme, the includes and the custom CSS load, and none in other files', async () => {
            const files = new Map([
                ...probeFiles,
                ['partials/footer.html', '<script src="http://stats.example.com/s.js"></script>'],
                ['assets/fonts.css', '@import  url("http://fonts.example.com/a.css");\n@import \'https://cdn.example.com/b.css\';\nbody{background:url(https://img.example.com/c.png)}'],
                ['assets/notes.css.txt', 'body{background:url(https://ignored.example.com/d.png)}'],
            ])
            const { source: s, publication } = site('  includes:\n    styles: Garden Styles\n', [
                pageDoc('Garden', '- beans\n'),
                pageDoc('Garden Styles', "```css\nbody{background:url('https://img.example.com/e.png')}\n```\n"),
            ])
            const { report } = await publishPublication(s, publication, probe({}, files))
            expect([...report.external].sort()).toEqual(
                [
                    'http://fonts.example.com/a.css',
                    'http://stats.example.com/s.js',
                    'https://cdn.example.com/b.css',
                    'https://img.example.com/c.png',
                    'https://img.example.com/e.png',
                ].sort(),
            )
        })
    })

    describe('the view', () => {
        it('describes a docs site and its pages', async () => {
            const { source: s, publication } = site('  url: https://garden.example.com/\n', [
                pageDoc('Garden', '## Beds\n\n- water the beans, see [[Kitchen]]\n'),
                pageDoc('Kitchen', '- bread $x^2$\n', 'public: true\npublications: [site]\ndate: 2026-05-01'),
                journalDoc('2026-06-01', '- picked [[Garden]] peas\n'),
                journalDoc('2026-06-03', '- weeded\n'),
            ])
            const { bundle } = await publishPublication(s, publication, probe())
            const home = text(bundle.get('index.html'))
            expect(home.split('|').slice(0, 11)).toEqual(['HOME', 'https:&#x2F;&#x2F;garden.example.com', 'url', 'docs', '', 'journals', 'posts', '', 'feed', 'undated', '(Garden)'])
            expect(home).toContain('|generated|home|')

            const garden = text(bundle.get('garden.html')).split('|')
            expect(garden.slice(0, 13)).toEqual(['PAGE', 'garden', 'page', 'garden.html', '', '', '', 'toc', 'backlinks', '', '', '', '6'])
            expect(garden[13]).toBe('1')
            const kitchen = text(bundle.get('kitchen.html')).split('|')
            expect(kitchen.slice(0, 12)).toEqual(['PAGE', 'kitchen', 'page', 'kitchen.html', '', '', 'dated', '', 'backlinks', 'math', '', ''])

            expect(text(bundle.get('2026-06-01.html'))).toBe('JOURNAL|2026-06-01')
            expect(text(bundle.get('journal.html'))).toBe('ARCHIVE|archive|(2026-06-03)(2026-06-01)')
            expect(text(bundle.get('404.html'))).toBe('MISSING|404||||||||page|404.html')
        })

        it('describes a blog without an address, journals or undated pages', async () => {
            const { source: s, publication } = site('  kind: blog\n', [pageDoc('Garden', '- beans\n', 'public: true\npublications: [site]\ndate: 2026-05-01')])
            const { bundle, report } = await publishPublication(s, publication, probe())
            expect(text(bundle.get('index.html')).split('|').slice(0, 11)).toEqual(['HOME', '', '', '', 'blog', '', 'posts', '', '', '', ''])
            expect(bundle.has('journal.html')).toBe(false)
            // An undated page is the menu of a blog without an outline; a post is not.
            expect(text(bundle.get('garden.html')).split('|')[14]).toBe('')
            expect(report.info).toContainEqual(expect.objectContaining({ code: 'no-site-url' }))
            expect(bundle.has('sitemap.xml')).toBe(false)
        })

        it('uses the home layout for the home page, found by an alias', async () => {
            const { source: s, publication } = site('  home: Plot\n', [pageDoc('Garden', '- beans\n', 'public: true\npublications: [site]', ['Plot'])])
            const { bundle } = await publishPublication(s, publication, probe())
            expect(text(bundle.get('index.html'))).toMatch(/^HOME\|.*\|home\|Garden$/)
            expect(bundle.has('garden.html')).toBe(false)
        })

        it('escapes the publication’s name in a generated index', async () => {
            const all: PublishDocument[] = [{ concept: 'Site', kind: 'page', aliases: [], text: '---\ntitle: "Beans & <Peas>"\npublication:\n  id: site\n---\n' }, pageDoc('Garden', '- beans\n')]
            const publication = discoverPublications(all).publications.find((p) => p.id === 'site')!
            const { bundle } = await publishPublication({ documents: all, readAsset: async () => null }, publication, probe())
            expect(text(bundle.get('index.html'))).toMatch(/\|Beans &amp; &lt;Peas&gt;$/)
        })

        it('reads a long page in more than a minute', async () => {
            const words = Array.from({ length: 450 }, () => 'beans').join(' ')
            const { source: s, publication } = site('', [pageDoc('Garden', `- ${words}\n`)])
            const { bundle } = await publishPublication(s, publication, probe())
            const fields = text(bundle.get('garden.html')).split('|')
            expect(fields[12]).toBe('450')
            expect(fields[13]).toBe('3')
        })

        it('shows each backlink’s line without its bullet or task box, and no link of a page to itself', async () => {
            const { source: s, publication } = site('', [
                pageDoc('Garden', '- see [[Garden]] again\n'),
                pageDoc('Kitchen', '- [ ] water the beans in [[Garden]]\n'),
            ])
            const { bundle } = await publishPublication(s, publication, probe())
            const garden = text(bundle.get('garden.html'))
            expect(garden).toContain('<li class="backlink-context">water the beans in <a href="garden.html" class="wikilink">Garden</a></li>')
            expect(garden.match(/class="backlink-context"/g)).toHaveLength(1)
        })
    })

    describe('addresses', () => {
        it('says which documents did not get the address they asked for, and why', async () => {
            const { source: s, publication } = site('  home: Garden\n', [
                pageDoc('Garden', '- home\n', 'public: true\npublications: [site]\nslug: plot'),
                pageDoc('Kitchen', '- one\n'),
                pageDoc('Pantry', '- two\n', 'public: true\npublications: [site]\nslug: larder'),
                pageDoc('Larder', '- two\n', 'public: true\npublications: [site]\nslug: larder'),
                pageDoc('Shed', '- three\n', 'public: true\npublications: [site]\nslug: "404"'),
                pageDoc('Barn', '- four\n', 'public: true\npublications: [site]\nslug: "!!!"'),
                pageDoc('Kitchen!', '- five\n'),
            ])
            const { report } = await publishPublication(s, publication, probe())
            const codes = (issues: typeof report.warnings) => issues.map((issue) => `${issue.code}:${issue.concept}`)
            expect(codes(report.warnings)).toEqual(expect.arrayContaining(['slug-ignored:Shed', 'slug-ignored:Barn']))
            expect(report.warnings.filter((w) => w.code === 'slug-taken')).toHaveLength(1)
            expect(report.info.map((i) => i.code)).not.toContain('slug-taken')
            expect(report.warnings.find((w) => w.concept === 'Shed')?.message).toContain('generated page')
            expect(report.warnings.find((w) => w.concept === 'Barn')?.message).toContain('leaves nothing')
            expect(codes(report.info)).toEqual(expect.arrayContaining(['slug-collision:Kitchen!', 'home-slug-ignored:Garden']))
        })
    })

    describe('includes, fences and assets', () => {
        it('says when an include page is missing or has no css fence, and copies an include’s assets', async () => {
            const read: string[] = []
            const { source: s, publication } = site(
                '  includes:\n    footer: Garden Footer\n    header: Nowhere\n    styles: Plain Styles\n',
                [
                    pageDoc('Garden', '![Beans](../assets/beans.png)\n\n![Beans again](../assets/beans.png)\n'),
                    pageDoc('Garden Footer', '![Logo](../assets/logo.png) $x^2$\n'),
                    pageDoc('Plain Styles', '- no styles here\n'),
                ],
                async (ref) => (read.push(ref), { bytes: new Uint8Array([1]), name: ref, type: 'image/png' }),
            )
            const { bundle, report } = await publishPublication(s, publication, probe())
            expect(report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['include-page-missing', 'include-no-css']))
            expect(read.sort()).toEqual(['../assets/beans.png', '../assets/logo.png'])
            expect(bundle.has('assets/logo.png')).toBe(true)
            expect(bundle.has('theme/custom.css')).toBe(false)
            // The maths is in the footer only, and still brings in KaTeX.
            expect(bundle.has('theme/katex/katex.min.css')).toBe(true)
        })

        it('copies no KaTeX without maths, and warns when maths has no KaTeX to copy', async () => {
            const { source: plain, publication } = site('', [pageDoc('Garden', '- beans\n')])
            const none = await publishPublication(plain, publication, probe())
            expect([...none.bundle.keys()].some((path) => path.startsWith('theme/katex/'))).toBe(false)
            const { source: maths } = site('', [pageDoc('Garden', '- $x^2$\n')])
            const missing = await publishPublication(maths, publication, probe({ katexAssets: undefined }))
            expect(missing.report.warnings).toContainEqual(expect.objectContaining({ code: 'katex-assets-unavailable' }))
            expect(missing.report.warnings).not.toContainEqual(expect.objectContaining({ code: 'asset-missing' }))
        })

        it('warns about a missing asset', async () => {
            const { source: s, publication } = site('', [pageDoc('Garden', '![Gone](../assets/gone.png)\n')])
            const { report } = await publishPublication(s, publication, probe())
            expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'asset-missing', concept: 'Garden' }))
        })

        it('highlights each distinct code fence once, and never maths or a fence without a language', async () => {
            const asked: string[] = []
            const { source: s, publication } = site('', [pageDoc('Garden', '```js\nconst a = 1\n```\n\n```js\nconst a = 1\n```\n\n```math\nx^2\n```\n\n```\nplain\n```\n')])
            await publishPublication(s, publication, probe({ highlightCode: async (lang) => (asked.push(lang), '<b>code</b>') }))
            expect(asked).toEqual(['js'])
        })

        it('asks the extensions about each distinct fence once, never a fence without a language, and warns once about one left out', async () => {
            const asked: string[] = []
            const block = '```garden.plan\n{"id":"k1"}\n```\n\n'
            const { source: s, publication } = site('', [pageDoc('Garden', `${block}${block}\`\`\`\nplain\n\`\`\`\n`)])
            const { report } = await publishPublication(s, publication, probe({ publishFence: (fence) => (asked.push(fence.info), undefined) }))
            expect(asked).toEqual(['garden.plan'])
            expect(report.warnings.filter((w) => w.code === 'extension-fence-left-out')).toHaveLength(1)
        })

        it('leaves out an ordinary fence an extension answers with nothing, and keeps a link’s picture', async () => {
            const { source: s, publication } = site('', [pageDoc('Garden', '```video\nhttps://youtu.be/abcdefghijk\n```\n\n```garden.plan\n{"id":"k1"}\n```\n')])
            const { bundle, report } = await publishPublication(
                s,
                publication,
                probe({
                    publishFence: (fence) =>
                        fence.info === 'video'
                            ? Promise.resolve(null)
                            : Promise.resolve({ kind: 'link', href: 'https://garden.example.com/plan', text: 'The plan', image: { src: 'https://garden.example.com/plan.png', alt: 'Plan' } }),
                }),
            )
            const garden = text(bundle.get('garden.html'))
            expect(garden).not.toContain('youtu.be')
            expect(garden).toContain('https://garden.example.com/plan.png')
            expect(report.warnings.map((w) => w.code)).not.toContain('extension-fence-failed')
        })

        it('draws each distinct diagram once, numbers them per page, and keeps a failed one as its source', async () => {
            const drawn: string[] = []
            const diagram = (src: string) => `\`\`\`mermaid\n${src}\n\`\`\`\n\n`
            const { source: s, publication } = site('  includes:\n    footer: Garden Footer\n', [
                pageDoc('Garden', `${diagram('graph TD; A-->B;')}${diagram('graph TD; A-->B;')}${diagram('graph LR; C-->D;')}`),
                pageDoc('Kitchen', diagram('graph LR; E-->F;')),
                pageDoc('Garden Footer', diagram('graph LR; G-->H;')),
            ])
            const { bundle } = await publishPublication(s, publication, probe({ renderMermaid: async (src) => (drawn.push(src), `<svg id="host"></svg>`) }))
            expect(drawn.sort()).toEqual(['graph LR; C-->D;\n', 'graph LR; E-->F;\n', 'graph LR; G-->H;\n', 'graph TD; A-->B;\n'])
            const ids = (path: string) => [...text(bundle.get(path)).matchAll(/<svg id="([^"]+)"/g)].map((m) => m[1])
            expect(ids('garden.html')).toEqual(['mermaid_garden_1', 'mermaid_garden_2', 'mermaid_garden_3'])
            expect(ids('kitchen.html')).toEqual(['mermaid_kitchen_1'])

            const failed = await publishPublication(s, publication, probe({ renderMermaid: async () => Promise.reject(new Error('no browser')) }))
            expect(failed.report.warnings).toContainEqual(expect.objectContaining({ code: 'mermaid-render-failed', concept: 'Garden' }))
            expect(text(failed.bundle.get('garden.html'))).toContain('<pre class="mermaid">')
        })

        it('draws each distinct map once, as png when asked, and reports one failure per document', async () => {
            const asked: string[] = []
            const map = '```map\nPebble Cove @ 50.74860, -4.07890\n```\n\n'
            const { source: s, publication } = site('', [pageDoc('Garden', `${map}${map}`)])
            const { bundle } = await publishPublication(s, publication, probe({ renderMap: async (src) => (asked.push(src), { bytes: new Uint8Array([1]), type: 'image/png', width: 10, height: 10 }) }))
            expect(asked).toHaveLength(1)
            expect([...bundle.keys()].filter((path) => path.startsWith('maps/'))).toEqual([expect.stringMatching(/\.png$/)])

            const other = '```map\nQuiet Bay @ 50.10000, -4.10000\n```\n\n'
            const twice = site('', [pageDoc('Garden', `${map}${other}`)])
            const failed = await publishPublication(twice.source, twice.publication, probe({ renderMap: async () => Promise.reject(new Error('no tiles')) }))
            expect(failed.report.errors).toHaveLength(1)
        })

        it('lists a site without journals or posts in its sitemap without their archives, and dates its pages', async () => {
            const { bundle } = await publishPublication(source, docs, environment())
            const sitemap = text(bundle.get('sitemap.xml'))
            expect(sitemap).toContain('<loc>https://docs.example.com/journal.html</loc>')
            expect(sitemap).toMatch(/guide\.html<\/loc>\s*<lastmod>2026-06-01<\/lastmod>/)
            const search = JSON.parse(text(bundle.get('search.json')))
            expect(search.documents.find((d: { url: string }) => d.url === 'guide.html').date).toBe('2026-06-01')

            const { source: s, publication } = site('  url: https://garden.example.com/\n', [pageDoc('Garden', '- beans\n')])
            const plain = await publishPublication(s, publication, probe())
            const plainMap = text(plain.bundle.get('sitemap.xml'))
            expect(plainMap).not.toContain('journal.html')
            expect(plainMap).not.toContain('posts.html')
            expect(plain.bundle.has('feed.xml')).toBe(false)

            const blog = site('  kind: blog\n  url: https://garden.example.com/\n', [pageDoc('Garden', '- beans\n', 'public: true\npublications: [site]\ndate: 2026-05-01')])
            const blogSite = await publishPublication(blog.source, blog.publication, probe())
            expect(text(blogSite.bundle.get('sitemap.xml'))).toContain('<loc>https://garden.example.com/posts.html</loc>')
        })
    })
})
