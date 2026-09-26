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
        expect(guide).toContain('<img src="assets/chart.png" alt="Chart" style="max-width:300px">')
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
