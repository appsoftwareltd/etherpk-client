/**
 * The files a [[Published Site]] derives from its pages: the search index, the sitemap and the
 * feed. Each is built from the publication's own documents and nothing else, which is the
 * whole protection argument (`Roadmap` → Protected content must not reach a published site):
 * a document the selection did not include cannot be in an index built from what it included.
 */

export interface SearchEntry {
    slug: string
    url: string
    title: string
    kind: 'page' | 'journal'
    date?: string
    excerpt: string
    text: string
}

export function searchIndexJson(entries: readonly SearchEntry[]): string {
    return `${JSON.stringify({ contract: 1, documents: entries }, null, 0)}\n`
}

/**
 * The same index as a script that assigns it to `window.etherpkSearchIndex`. A site opened
 * from disk (`file://`) cannot `fetch` its own `search.json` (browsers refuse cross-origin
 * reads from an opaque origin), but a `<script src>` is allowed, so the theme's search falls
 * back to loading this when the fetch fails.
 */
export function searchIndexScript(entries: readonly SearchEntry[]): string {
    return `window.etherpkSearchIndex=${JSON.stringify({ contract: 1, documents: entries }, null, 0)};\n`
}

function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export interface SitemapEntry {
    url: string
    lastmod?: string
}

/** `siteUrl` is the site's absolute address; entries are site-relative paths. */
export function sitemapXml(siteUrl: string, entries: readonly SitemapEntry[]): string {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for (const entry of entries) {
        lines.push('  <url>')
        lines.push(`    <loc>${escapeXml(`${siteUrl}/${entry.url}`)}</loc>`)
        if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`)
        lines.push('  </url>')
    }
    lines.push('</urlset>', '')
    return lines.join('\n')
}

export interface FeedItem {
    title: string
    url: string
    date: string
    description: string
}

/** RFC 822 date for a calendar day, at midnight UTC: what RSS readers expect. */
function rfc822(day: string): string {
    const d = new Date(`${day}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? day : d.toUTCString()
}

export function feedXml(siteUrl: string, siteTitle: string, items: readonly FeedItem[]): string {
    const entries = items.map(
        (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(`${siteUrl}/${item.url}`)}</link>
      <guid>${escapeXml(`${siteUrl}/${item.url}`)}</guid>
      <pubDate>${escapeXml(rfc822(item.date))}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`,
    )
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${escapeXml(siteUrl)}/</link>
    <description>${escapeXml(siteTitle)}</description>
    <atom:link href="${escapeXml(siteUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
${entries.join('\n')}
  </channel>
</rss>
`
}
