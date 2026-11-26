/**
 * The Theme editor's preview (ADR 0082), as a service worker hosts it.
 *
 * A page rendered inside the app's own document inherits the app's Content Security Policy, which
 * allows no inline script; a theme's search script (and the script that keeps the page picker in
 * step) could never run in a `srcdoc` frame. A response served from here is a real navigation
 * with a policy of its own, so the Theme editor posts the rendered site to this worker and frames
 * `/__etherpk-preview/<id>/index.html`. The response carries a `sandbox` policy, so the document
 * has an opaque origin and nothing in the preview reaches the app's storage; because such a
 * document's own requests are not this worker's to answer, every page arrives self-contained
 * (stylesheets and scripts inlined, images as data urls). The bundle lives in this worker's
 * memory only: when the worker is restarted the frame gets a small page saying so, and the editor
 * re-posts on the next Update preview.
 *
 * In a module of its own because a Native App's service worker hosts the preview and nothing
 * else (`installed.ts`): a Native App's files are on the device already.
 */

/** What the preview's addresses start with. `host/preview.ts` builds them. */
export const PREVIEW_PREFIX = '/__etherpk-preview/'

/** id → Map<path, { body, type }>. */
const previews = new Map<string, Map<string, { body: string | Uint8Array; type: string }>>()

const MIME: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
}

function mimeOf(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return MIME[ext] || 'application/octet-stream'
}

/** Tells the parent which page the frame is showing, so its picker follows a click. */
const PAGE_SCRIPT =
    "<script>window.parent.postMessage({ type: 'etherpk-preview-page', page: location.pathname.split('/').slice(3).join('/') }, '*')</script>"

/** Keep the sites the Theme editor posts. */
export function keepPostedPreviews(sw: ServiceWorkerGlobalScope): void {
    sw.addEventListener('message', (event) => {
        const data = event.data as { type?: unknown; id?: unknown; files?: unknown } | null
        if (!data || typeof data !== 'object' || typeof data.id !== 'string') return
        if (data.type === 'etherpk-preview-set' && Array.isArray(data.files)) {
            previews.set(data.id, siteOf(data.files))
            event.ports[0]?.postMessage({ ok: true })
        } else if (data.type === 'etherpk-preview-clear') {
            previews.delete(data.id)
        }
    })
}

function siteOf(files: unknown[]): Map<string, { body: string | Uint8Array; type: string }> {
    const site = new Map<string, { body: string | Uint8Array; type: string }>()
    for (const entry of files) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
        site.set(entry[0], { body: entry[1] as string | Uint8Array, type: mimeOf(entry[0]) })
    }
    return site
}

function expired(): Response {
    return new Response(
        '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#404040"><p>This preview has expired (its background worker was restarted). Press <strong>Update preview</strong> to render it again.</p></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
}

/** The preview and the file an address names: `<prefix><id>/<path>`, with the site's front page where it names no file. */
function addressed(url: URL): { id: string; path: string } {
    const rest = url.pathname.slice(PREVIEW_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash === -1) return { id: rest, path: 'index.html' }
    const path = rest.slice(slash + 1) || 'index.html'
    try {
        return { id: rest.slice(0, slash), path: decodeURIComponent(path) }
    } catch {
        // Left as written.
        return { id: rest.slice(0, slash), path }
    }
}

/** The answer to a request for a page of a preview. */
export async function previewResponse(url: URL): Promise<Response> {
    const { id, path } = addressed(url)
    const bundle = previews.get(id)
    const file = bundle?.get(path)
    if (!file) return bundle ? new Response('Not found', { status: 404 }) : expired()
    let body = file.body
    if (file.type.startsWith('text/html') && typeof body === 'string') {
        body = body.includes('</body>') ? body.replace('</body>', PAGE_SCRIPT + '</body>') : body + PAGE_SCRIPT
    }
    return new Response(body as BodyInit, {
        status: 200,
        headers: {
            'Content-Type': file.type,
            'Cache-Control': 'no-store',
            // The preview's own policy: what a static host would give the site (nothing), plus the
            // sandbox that gives the document an opaque origin, so a theme's script runs here with
            // no reach into the app. The frame's own sandbox attribute has to allow same-origin for
            // this navigation to reach the worker at all; this is what takes it away again.
            'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
            'X-Content-Type-Options': 'nosniff',
        },
    })
}
