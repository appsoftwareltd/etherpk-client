/**
 * Pre-rendered HTML fragments for CSS-only themes (ADR 0082): the navigation, table of contents,
 * backlinks, the generated index and the journal archive, with documented classes, so a theme
 * as short as an as-notes layout can place them with `{{{fragments.nav}}}` while the default
 * themes shape the same lists from the view's data.
 */

import type { NavNode } from './nav'
import type { TocItem } from './markdown/render'

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A nav node as the view carries it per page: the tree plus where the current page sits. */
export interface NavViewNode extends NavNode {
    current: boolean
    /** A descendant is the current page. */
    open: boolean
    hasChildren: boolean
    children: NavViewNode[]
}

/** The nav tree with `current` and `open` set for the page at `url`. */
export function navFor(nav: readonly NavNode[], url: string): NavViewNode[] {
    return nav.map((node) => {
        const children = navFor(node.children, url)
        const current = node.href === url
        return { ...node, current, open: children.some((c) => c.current || c.open), hasChildren: children.length > 0, children }
    })
}

export function navHtml(nav: readonly NavViewNode[]): string {
    if (nav.length === 0) return ''
    const items = nav.map((node) => {
        const cls = [node.current ? 'nav-current' : '', node.open ? 'nav-open' : '', node.href ? '' : 'nav-group'].filter(Boolean).join(' ')
        // An entry is one anchor with plain text: a scoped concept's chained anchors cannot nest
        // inside it (anchors do not nest), so its scope is linked in the heading, not the menu.
        const label = node.href
            ? `<a href="${escapeHtml(node.href)}"${node.external ? ' rel="noopener"' : ''}>${escapeHtml(node.label)}</a>`
            : `<span>${node.labelHtml}</span>`
        return `<li${cls ? ` class="${cls}"` : ''}>${label}${navHtml(node.children)}</li>`
    })
    return `<ul class="site-nav-list">${items.join('')}</ul>`
}

export function tocHtml(toc: readonly TocItem[]): string {
    if (toc.length === 0) return ''
    const items = toc.map((item) => `<li class="toc-level-${item.level}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`)
    return `<nav class="toc"><ul>${items.join('')}</ul></nav>`
}

export interface BacklinkView {
    title: string
    titleHtml: string
    url: string
    kind: 'page' | 'journal'
    refs: { contextHtml: string }[]
}

// Every list below links a document by its plain title: a scoped concept's chained anchors
// cannot sit inside the list's own anchor (anchors do not nest), so `titleHtml` is for headings.
export function backlinksHtml(backlinks: readonly BacklinkView[]): string {
    if (backlinks.length === 0) return ''
    const items = backlinks.map((b) => {
        const refs = b.refs.map((r) => `<li class="backlink-context">${r.contextHtml}</li>`).join('')
        return `<li class="backlink-source"><a href="${escapeHtml(b.url)}">${escapeHtml(b.title)}</a><ul>${refs}</ul></li>`
    })
    return `<section class="backlinks"><h2>Linked references</h2><ul class="backlink-list">${items.join('')}</ul></section>`
}

export interface PageSummary {
    title: string
    titleHtml: string
    url: string
    kind: 'page' | 'journal'
    date?: string
    excerpt: string
}

/**
 * The generated front page of a site with no home document: the outline as a table of
 * contents - groups, their pages, outside links, nested as the sidebar shows them - and then,
 * under "Other pages", every published page the outline leaves out, alphabetically, so nothing
 * is unreachable from the front page. A site with no outline gets the flat list alone. A docs
 * set is bounded and browsed by structure, which is why this is a contents page and never a
 * cut with a "more" link the way a blog's front page is.
 */
export function indexHtml(nav: readonly NavNode[], pages: readonly PageSummary[]): string {
    const linked = new Set<string>()
    const walk = (nodes: readonly NavNode[]) => {
        for (const node of nodes) {
            if (node.href) linked.add(node.href)
            walk(node.children)
        }
    }
    walk(nav)
    const others = pages.filter((p) => !linked.has(p.url))
    if (nav.length === 0 && others.length === 0) return '<p class="index-empty">Nothing is published yet.</p>'
    const list = (items: readonly PageSummary[]) => `<ul class="page-index-list">${items.map((p) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></li>`).join('')}</ul>`
    if (nav.length === 0) return list(others)
    const tree = (nodes: readonly NavNode[]): string =>
        `<ul class="page-index-list">${nodes
            .map((node) => {
                const children = node.children.length > 0 ? tree(node.children) : ''
                if (!node.href) return `<li class="page-index-group"><span class="page-index-group-label">${node.labelHtml}</span>${children}</li>`
                return `<li><a href="${escapeHtml(node.href)}"${node.external ? ' rel="noopener"' : ''}>${escapeHtml(node.label)}</a>${children}</li>`
            })
            .join('')}</ul>`
    const contents = `<nav class="page-index" aria-label="Contents">${tree(nav)}</nav>`
    return others.length > 0 ? `${contents}<h2 class="page-index-other">Other pages</h2>${list(others)}` : contents
}

/** Dated documents grouped by year, newest first, as the view carries them for an archive page. */
export interface PostsYear {
    year: string
    /** How many, for a widget that lists years; Mustache cannot read a length. */
    count: number
    posts: PageSummary[]
}

export function postsByYear(posts: readonly PageSummary[]): PostsYear[] {
    const years: PostsYear[] = []
    for (const post of posts) {
        const year = (post.date ?? '').slice(0, 4)
        const last = years[years.length - 1]
        if (last && last.year === year) {
            last.posts.push(post)
            last.count++
        } else years.push({ year, count: 1, posts: [post] })
    }
    return years
}

/** The posts archive: every dated document under a heading per year, newest first. */
export function postsArchiveHtml(posts: readonly PageSummary[]): string {
    if (posts.length === 0) return ''
    const groups = postsByYear(posts).map((group) => {
        const items = group.posts.map(
            (p) => `<li><time datetime="${escapeHtml(p.date ?? '')}">${escapeHtml(p.date ?? '')}</time> <a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></li>`,
        )
        return `<h2 class="posts-archive-year" id="y${escapeHtml(group.year)}">${escapeHtml(group.year)}</h2><ul class="posts-archive-list">${items.join('')}</ul>`
    })
    return `<section class="posts-archive">${groups.join('')}</section>`
}

export function archiveHtml(journals: readonly PageSummary[]): string {
    if (journals.length === 0) return ''
    const items = journals.map(
        (j) => `<li><time datetime="${escapeHtml(j.date ?? '')}">${escapeHtml(j.date ?? '')}</time> <a href="${escapeHtml(j.url)}">${escapeHtml(j.title)}</a>${j.excerpt ? `<p>${escapeHtml(j.excerpt)}</p>` : ''}</li>`,
    )
    return `<ul class="journal-archive">${items.join('')}</ul>`
}
