/**
 * A page of a [[Published Site]] made self-contained for a sandboxed preview frame (ADR 0082,
 * the Theme editor's preview). The frame has an opaque origin - deliberately, so a theme's
 * script (or an include's) previews with no reach into the app - which means it can load
 * nothing by relative url: every stylesheet and script the page links from the bundle is
 * inlined, every image it references is a data url, the search index becomes a data url the
 * theme's script can fetch, and a link to another page of the site becomes a message to the
 * parent, which swaps the page. Pure string work over the bundle; no DOM.
 */

import type { SiteBundle, SiteFile } from '../types'

export const PREVIEW_NAVIGATE = 'etherpk-preview-navigate'

function escapeAttribute(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function textOf(file: SiteFile): string {
    return typeof file === 'string' ? file : new TextDecoder().decode(file)
}

function base64Of(file: SiteFile): string {
    const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    json: 'application/json',
    css: 'text/css',
    js: 'text/javascript',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
}

function mimeOf(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return MIME[ext] ?? 'application/octet-stream'
}

/** A bundle file as a data url, or null when the bundle has no such file. */
export function dataUrlOf(bundle: SiteBundle, path: string): string | null {
    const file = bundle.get(path)
    if (file === undefined) return null
    return `data:${mimeOf(path)};base64,${base64Of(file)}`
}

/** Decode an href as written in the HTML back to a bundle path (`assets/q3%20report.pdf` → `assets/q3 report.pdf`). */
function bundlePathOf(href: string): string | null {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return null
    const clean = href.split(/[?#]/)[0]
    try {
        return decodeURIComponent(clean)
    } catch {
        return clean
    }
}

/** The script that turns a click on a site link into a message the parent acts on. */
const NAVIGATE_SCRIPT = `<script>
(function () {
    document.addEventListener('click', function (event) {
        var target = event.target instanceof Element ? event.target.closest('a[data-preview-page]') : null;
        if (!target) return;
        event.preventDefault();
        window.parent.postMessage({ type: '${PREVIEW_NAVIGATE}', page: target.getAttribute('data-preview-page') }, '*');
    });
})();
</script>`

/** The paths of the bundle's pages, the home first, then pages by name, the archive and the 404 last. */
export function previewPages(bundle: SiteBundle): string[] {
    const pages = [...bundle.keys()].filter((p) => p.endsWith('.html') && !p.includes('/'))
    const rank = (p: string) => (p === 'index.html' ? 0 : p === 'journal.html' ? 2 : p === '404.html' ? 3 : 1)
    return pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export interface PreviewDocumentOptions {
    /**
     * What a link to another page of the site becomes: `message` posts to the parent (the srcdoc
     * fallback, where a relative url resolves to nothing); `navigate` leaves it as the relative
     * url the service worker route serves.
     */
    links: 'message' | 'navigate'
}

/** The page at `path` made self-contained for an opaque-origin frame, or null when the bundle has no such page. */
export function previewDocument(bundle: SiteBundle, path: string, options: PreviewDocumentOptions = { links: 'message' }): string | null {
    const page = bundle.get(path)
    if (page === undefined) return null
    let html = textOf(page)

    // Stylesheets and scripts from the bundle: inline them.
    html = html.replace(/<link\b([^>]*)\bhref="([^"]+)"([^>]*)>/gi, (match, before: string, href: string, after: string) => {
        if (!/rel="stylesheet"/i.test(before + after)) return match
        const file = bundlePathOf(href)
        const css = file === null ? undefined : bundle.get(file)
        if (css === undefined) return match
        return `<style data-preview-of="${escapeAttribute(file as string)}">${textOf(css).replace(/<\/style/gi, '<\\/style')}</style>`
    })
    html = html.replace(/<script\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/script>/gi, (match, before: string, src: string, after: string) => {
        const file = bundlePathOf(src)
        const js = file === null ? undefined : bundle.get(file)
        if (js === undefined) return match
        const attributes = `${before} ${after}`.replace(/\s+/g, ' ').trim()
        return `<script data-preview-of="${escapeAttribute(file as string)}"${attributes ? ` ${attributes}` : ''}>${textOf(js).replace(/<\/script/gi, '<\\/script')}</script>`
    })

    // Images and other assets: data urls.
    html = html.replace(/\b(src|href|poster)="([^"]+)"/gi, (match, attr: string, value: string) => {
        const file = bundlePathOf(value)
        if (file === null || file.endsWith('.html')) return match
        const data = dataUrlOf(bundle, file)
        return data === null ? match : `${attr}="${data}"`
    })

    // The search index: the theme's script fetches it by the attribute.
    html = html.replace(/data-search-index="([^"]+)"/gi, (match, value: string) => {
        const data = dataUrlOf(bundle, value)
        return data === null ? match : `data-search-index="${data}"`
    })

    if (options.links === 'navigate') return html

    // Links to other pages of the site: a message to the parent.
    html = html.replace(/<a\b([^>]*)\bhref="([^"]+)"/gi, (match, before: string, href: string) => {
        const file = bundlePathOf(href)
        if (file === null || !file.endsWith('.html') || !bundle.has(file)) return match
        return `<a${before}href="#" data-preview-page="${escapeAttribute(file)}"`
    })

    return html.includes('</body>') ? html.replace('</body>', `${NAVIGATE_SCRIPT}</body>`) : `${html}${NAVIGATE_SCRIPT}`
}

// -- The service-worker route ----------------------------------------------------------------

export const PREVIEW_PATH_PREFIX = '/__etherpk-preview/'
/** Posted by a served preview page on load, so the parent's page picker follows a click. */
export const PREVIEW_PAGE = 'etherpk-preview-page'

export interface PreviewSession {
    id: string
    /** The url to frame for a page of the bundle. */
    urlFor(page: string): string
    /** Forget the bundle in the worker. */
    close(): void
}

/**
 * Hand a bundle to the service worker and get urls under its preview route, or null where there
 * is no worker to serve it (an insecure context, a browser without one, a registration that
 * failed). The caller then falls back to {@link previewDocument} in a srcdoc frame, which shows
 * the page but runs none of its scripts.
 *
 * The frame that shows a served page needs `allow-same-origin` in its sandbox for the
 * navigation to be the worker's to answer; the worker's response then carries a `sandbox` policy
 * of its own, so the document that results has an opaque origin all the same. The app's own
 * pages carry `frame-ancestors 'none'`, so if the worker ever failed to answer, the frame would
 * show the app's refusal rather than the app.
 */
export async function openPreviewSession(bundle: SiteBundle, previous?: PreviewSession | null): Promise<PreviewSession | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
    let registration: ServiceWorkerRegistration | undefined
    try {
        registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
        ])
    } catch {
        return null
    }
    const worker = registration?.active
    if (!worker) return null
    const id = previous?.id ?? crypto.randomUUID()
    // The served document is sandboxed to an opaque origin by the worker's response, and an
    // opaque-origin document's own requests are not served by the worker - only navigations
    // are - so every page is handed over self-contained, with its links left as the relative
    // urls a navigation resolves under the route.
    const files: [string, SiteFile][] = [...bundle.entries()].map(([path, file]) =>
        path.endsWith('.html') && !path.includes('/') ? [path, previewDocument(bundle, path, { links: 'navigate' }) ?? file] : [path, file],
    )
    const acked = await new Promise<boolean>((resolve) => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => resolve(false), 3000)
        channel.port1.onmessage = () => {
            clearTimeout(timer)
            resolve(true)
        }
        try {
            worker.postMessage({ type: 'etherpk-preview-set', id, files }, [channel.port2])
        } catch {
            clearTimeout(timer)
            resolve(false)
        }
    })
    if (!acked) return null
    return {
        id,
        urlFor: (page) => `${PREVIEW_PATH_PREFIX}${id}/${page.split('/').map(encodeURIComponent).join('/')}`,
        close: () => {
            try {
                worker.postMessage({ type: 'etherpk-preview-clear', id })
            } catch {
                // The worker is gone; there is nothing to clear.
            }
        },
    }
}
