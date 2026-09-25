/**
 * Every bundled theme renders the fixture graph: the CI check the plan promises, so a theme
 * cannot ship broken. Golden-by-assertion rather than golden files: the checks are the things a
 * reader would notice missing (the shell, the nav, the content, the search script, no leftover
 * Mustache), which survive a stylesheet tweak.
 */

import { describe, expect, it } from 'vitest'

import { bundledTheme, bundledThemeNames } from '@appsoftwareltd/etherpk-themes'

import { CIPHER_TEXT, SECRET_BODY, documents, source } from './fixture-graph'
import { discoverPublications } from './publication'
import { publishPublication } from './publish'
import { createThemeLoader } from './theme/sources'
import type { Publication, PublishDocument } from './types'

const publications = discoverPublications(documents).publications
/** A minimal graph page of that name, for adding one to the fixture source. */
function pageNamed(concept: string): PublishDocument {
    return { concept, kind: 'page', text: '', aliases: [] }
}
const docs = publications.find((p) => p.id === 'docs') as Publication
const blog: Publication = { ...(publications.find((p) => p.id === 'blog') as Publication), selection: 'all-public', url: 'https://blog.example.com' }

const env = {
    loadTheme: createThemeLoader({}),
    renderMermaid: async (src: string) => `<svg data-src="${src.trim()}"></svg>`,
    katexAssets: async () => new Map([['katex.min.css', '.katex{}']]),
    now: () => new Date('2026-09-18T12:00:00Z'),
}

/** The fixture publication of the first kind the theme declares: its home ground. */
function publicationFor(name: string): Publication {
    const kinds = (JSON.parse(bundledTheme(name)?.files.get('theme.json') ?? '{}') as { kinds?: string[] }).kinds ?? ['docs']
    return kinds[0] === 'blog' ? { ...blog, theme: name } : { ...docs, theme: name }
}

describe.each(bundledThemeNames())('bundled theme %s', (name) => {
    const publication = publicationFor(name)

    it('renders the fixture publication without errors or leftover template syntax', async () => {
        const { bundle, report } = await publishPublication(source, publication, env)
        expect(report.errors).toEqual([])
        expect(report.theme?.name).toBe(name)
        for (const [path, content] of bundle) {
            if (!path.endsWith('.html')) continue
            const html = content as string
            expect(html, path).not.toMatch(/\{\{|\}\}/)
            expect(html, path).toContain('<!DOCTYPE html>')
            expect(html, path).toContain('theme/theme.css')
            expect(html, path).toContain('theme/search.js')
            // The search form names both the index and its script twin, so a site opened from disk searches too.
            expect(html, path).toMatch(/data-search-index="search\.json"[^>]*data-search-script="search-index\.js"/)
            expect(html, path).not.toContain(SECRET_BODY)
            expect(html, path).not.toContain(CIPHER_TEXT)
        }
        // The stylesheet and the script are real text, not the empty stub a misconfigured test
        // runner hands back for a css import.
        expect((bundle.get('theme/theme.css') as string).length).toBeGreaterThan(1000)
        expect(bundle.get('theme/search.js') as string).toContain('search.json')
    })

    const takesBlog = ((JSON.parse(bundledTheme(name)?.files.get('theme.json') ?? '{}') as { kinds?: string[] }).kinds ?? []).includes('blog')
    it.skipIf(!takesBlog)('as a blog lists the recent posts with a link to every post, and the archive by year', async () => {
        // Two dated documents in the fixture; `recent: 1` shows the cut. The front page must link
        // the archive whenever it does not list everything, whatever the theme's own look.
        const { bundle, report } = await publishPublication(source, { ...blog, theme: name, recent: 1 }, env)
        expect(report.errors).toEqual([])
        const index = bundle.get('index.html') as string
        expect(index).toContain('2026-06-02.html')
        expect(index).not.toContain('href="guide.html"')
        expect(index).toMatch(/href="posts\.html"[^>]*>[^<]*2 posts/i)
        const posts = bundle.get('posts.html') as string
        expect(posts).not.toMatch(/\{\{|\}\}/)
        expect(posts).toContain('>2026<')
        expect(posts).toContain('href="guide.html"')
        expect(posts).toContain('href="2026-06-02.html"')
        // Everything fits: the front page still ends with the link, because the archive (by
        // year, with counts) is the one place every post is listed and the menu never lists them.
        const all = await publishPublication(source, { ...blog, theme: name }, env)
        expect(all.bundle.get('index.html') as string).toMatch(/href="posts\.html"[^>]*>[^<]*2 posts/i)
        expect(all.bundle.has('posts.html')).toBe(true)
        // With no outline the menu is the blog's pages, not its posts: the front page and the
        // archive are where posts are listed.
        const flat = await publishPublication(source, { ...blog, theme: name, outline: '' }, env)
        const nav = (flat.bundle.get('release-notes.html') as string).match(/<(?:nav|ul)[^>]*class="[^"]*site-nav[^"]*"[\s\S]*?<\/(?:nav|ul)>/)?.[0] ?? ''
        expect(nav, 'site navigation').not.toBe('')
        expect(nav).toContain('href="release-notes.html"')
        expect(nav).not.toContain('href="guide.html"')
        // The journal archive keeps its own heading.
        expect(bundle.get('journal.html') as string).toMatch(/journal/i)
        expect(bundle.get('journal.html') as string).not.toMatch(/\{\{|\}\}/)
    })

    const takesDocs = ((JSON.parse(bundledTheme(name)?.files.get('theme.json') ?? '{}') as { kinds?: string[] }).kinds ?? []).includes('docs')
    it.skipIf(!takesDocs)('as a docs site with no home page shows the outline as a contents page, plus the pages it leaves out', async () => {
        const { bundle, report } = await publishPublication(source, { ...docs, theme: name, home: undefined, outline: '- Reference\n  - [[Physics]]\n' }, env)
        expect(report.errors).toEqual([])
        const index = bundle.get('index.html') as string
        expect(index).toContain('<span class="page-index-group-label">Reference</span>')
        expect(index).toContain('<h2 class="page-index-other">Other pages</h2>')
        expect(index).toContain('href="guide.html"')
        // The theme draws the contents rather than its own flat list beside it: outside the site
        // navigation (and Stack's pages widget), the page body links each page once.
        const start = index.indexOf('<nav class="page-index"')
        const end = index.indexOf('</ul>', index.indexOf('page-index-other')) + '</ul>'.length
        const body = index.slice(start, end)
        expect(body.match(/href="physics\.html"/g)?.length).toBe(1)
        expect(body.match(/href="guide\.html"/g)?.length).toBe(1)
    })

    it('shows the navigation, the content, the linked references and the current page', async () => {
        const { bundle } = await publishPublication(source, publication, env)
        const guide = bundle.get('guide.html') as string
        // The docs outline lists Guide; the blog outline lists Release Notes.
        const inNav = publication.kind === 'blog' ? (bundle.get('release-notes.html') as string) : guide
        expect(inNav).toContain('aria-current="page"')
        expect(guide).toContain('<a href="physics.html" class="wikilink">Phys</a>')
        expect(guide).toContain('Linked references')
        // Each theme dresses its heading differently; what matters is the title and its chained anchors.
        expect(guide).toMatch(/<h1[^>]*>Guide<\/h1>/)
        const advanced = bundle.get('guide-advanced.html') as string
        expect(advanced).toMatch(/<h1[^>]*><a href="guide.html" class="wikilink">Guide<\/a><a href="guide-advanced.html" class="wikilink"> Advanced<\/a><\/h1>/)
        expect(bundle.get('404.html')).toContain('Not published')
        expect(bundle.get('journal.html')).toContain('2026-06-02.html')
    })

    it('puts the EtherPK icon before the site title, from a logo partial a publication can replace', async () => {
        const { bundle } = await publishPublication(source, publication, env)
        const guide = bundle.get('guide.html') as string
        // The icon is inline SVG (nothing to fetch), marked decorative, inside the title link.
        const title = guide.match(/<a class="[^"]*\bsite-title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/)
        expect(title, 'site title link').not.toBeNull()
        expect(title?.[1]).toMatch(/<svg class="site-logo"[^>]*aria-hidden="true"/)
        // The brand mark from resources/brand, not a stand-in icon (2026-09-19).
        expect(title?.[1]).toContain('viewBox="0 0 191.82 166.13"')
        expect(title?.[1]).toContain('fill="currentColor"')
        // The icon comes from its own partial, so a theme edit or a `logo` include swaps it alone.
        const { theme } = await env.loadTheme(name)
        expect(theme.files.get('partials/header.html')).toContain('{{> logo}}')
        expect(theme.manifest.includes.map((s) => s.name)).toContain('logo')
        const withLogo = await publishPublication(
            // Public and in the publication, as any content that reaches the site must be.
            { ...source, documents: [...source.documents, { ...pageNamed('Logo'), text: '---\npublic: true\npublications: [docs, blog]\n---\n<img src="https://example.com/logo.png" alt="Example">\n' }] },
            { ...publication, includes: { ...publication.includes, logo: 'Logo' } },
            env,
        )
        const swapped = withLogo.bundle.get('guide.html') as string
        expect(swapped).toContain('<img src="https://example.com/logo.png" alt="Example">')
        expect(swapped).not.toContain('site-logo')
    })

    it('carries a hamburger toggle for the drawer on small screens outside the header include', async () => {
        if (name !== 'etherpk-docs') return
        const { bundle } = await publishPublication(source, publication, env)
        const guide = bundle.get('guide.html') as string
        // A button with an accessible name and the drawer relationship, an icon rather than a
        // word, and placed by shell-top so a replaced header include keeps the drawer reachable.
        expect(guide).toMatch(/<button class="nav-toggle"[^>]*aria-controls="site-nav"[^>]*aria-expanded="false"[^>]*aria-label="Menu"/)
        const { theme } = await env.loadTheme(name)
        expect(theme.files.get('partials/header.html')).not.toContain('nav-toggle')
        expect(theme.files.get('partials/shell-top.html')).toContain('class="nav-toggle"')
        // The drawer is laid out by the stylesheet as a fixed panel beside a fixed toggle, so the
        // shell never has to reserve a row for the button (that was the full-height Menu button).
        const css = bundle.get('theme/theme.css') as string
        expect(css).toMatch(/\.nav-toggle\s*\{[^}]*position:\s*fixed/)
        expect(css).toMatch(/\.shell\s*\{[^}]*display:\s*block/)
    })

    it('keeps its own search and drawer script when a publication fills the scripts slot', async () => {
        // The scripts slot is for adding a script (analytics, a widget); it used to replace the
        // theme's scripts partial, so a page holding one analytics tag silently switched off
        // search and the phone drawer on docs.etherpk.com (2026-09-19).
        const { bundle } = await publishPublication(
            { ...source, documents: [...source.documents, { ...pageNamed('Analytics'), text: '---\npublic: true\npublications: [docs, blog]\n---\n<script defer src="https://analytics.example/t.js" data-website-id="x"></script>\n' }] },
            { ...publication, includes: { ...publication.includes, scripts: 'Analytics' } },
            env,
        )
        const guide = bundle.get('guide.html') as string
        expect(guide).toContain('theme/search.js')
        expect(guide).toContain('https://analytics.example/t.js')
        // The added script comes after the theme's, and the theme's file is still in the site.
        expect(guide.indexOf('theme/search.js')).toBeLessThan(guide.indexOf('analytics.example'))
        expect(bundle.has('theme/search.js')).toBe(true)
    })

    it('declares every include slot it renders and renders every slot it declares', async () => {
        const { theme } = await env.loadTheme(name)
        for (const slot of theme.manifest.includes) {
            if (slot.kind === 'css') continue
            expect(theme.files.has(`partials/${slot.name}.html`), slot.name).toBe(true)
            const used = [...theme.files.entries()].some(([path, text]) => path.startsWith('layouts/') || path.startsWith('partials/') ? text.includes(`{{> ${slot.name}}}`) : false)
            expect(used, `slot ${slot.name} is rendered somewhere`).toBe(true)
        }
        const listed = new Set(theme.manifest.files)
        for (const path of theme.files.keys()) expect(listed.has(path), `${path} is listed in theme.json files`).toBe(true)
    })
})
