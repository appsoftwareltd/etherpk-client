/**
 * The Client's service worker: registered for PWA installability, and the host of the Theme
 * editor's preview (ADR 0082).
 *
 * No caching: every ordinary request passes straight through to the network, and deliberately
 * NOT via `event.respondWith(fetch(event.request))`. That wrapper is not a pass-through: it
 * converts any transient failure (a dev-server restart, a dropped connection) into a hard
 * "network error response" the browser would otherwise handle itself, and it intercepts WORKER
 * fetches too, so it broke the index worker's wasm load and silently downgraded the persisted
 * index to memory (live, 2026-07-28). Only the preview path below is answered here.
 *
 * The preview. A page rendered inside the app's own document inherits the app's Content
 * Security Policy, which allows no inline script; a theme's search script (and the script that
 * keeps the page picker in step) could never run in a `srcdoc` frame. A response served from
 * here is a real navigation with a policy of its own, so the Theme editor posts the rendered
 * site to this worker and frames `/__etherpk-preview/<id>/index.html`. The response carries a
 * `sandbox` policy, so the document has an opaque origin and nothing in the preview reaches the
 * app's storage; because such a document's own requests are not this worker's to answer, every
 * page arrives self-contained (stylesheets and scripts inlined, images as data urls). The bundle
 * lives in this worker's memory only: when the worker is restarted the frame gets a small page
 * saying so, and the editor re-posts on the next Update preview.
 */

const PREVIEW_PREFIX = '/__etherpk-preview/'

/** id → Map<path, { body: string | Uint8Array, type: string }>. */
const previews = new Map()

const MIME = {
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

function mimeOf(path) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return MIME[ext] || 'application/octet-stream'
}

/** Tells the parent which page the frame is showing, so its picker follows a click. */
const PAGE_SCRIPT =
    "<script>window.parent.postMessage({ type: 'etherpk-preview-page', page: location.pathname.split('/').slice(3).join('/') }, '*')</script>"

self.addEventListener('install', () => {
    // Activate immediately without waiting for existing clients to close
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    // Take control of all clients as soon as the SW activates
    event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'etherpk-preview-set' && typeof data.id === 'string' && Array.isArray(data.files)) {
        const files = new Map()
        for (const entry of data.files) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
            files.set(entry[0], { body: entry[1], type: mimeOf(entry[0]) })
        }
        previews.set(data.id, files)
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true })
    } else if (data.type === 'etherpk-preview-clear' && typeof data.id === 'string') {
        previews.delete(data.id)
    }
})

function expired() {
    return new Response(
        '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#374151"><p>This preview has expired (the browser restarted its background worker). Press <strong>Update preview</strong> to render it again.</p></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    if (url.origin !== self.location.origin || !url.pathname.startsWith(PREVIEW_PREFIX)) return
    const rest = url.pathname.slice(PREVIEW_PREFIX.length)
    const slash = rest.indexOf('/')
    const id = slash === -1 ? rest : rest.slice(0, slash)
    let path = slash === -1 ? '' : rest.slice(slash + 1)
    if (path === '') path = 'index.html'
    try {
        path = decodeURIComponent(path)
    } catch {
        // Left as written.
    }
    const files = previews.get(id)
    const file = files && files.get(path)
    if (!file) {
        event.respondWith(files ? new Response('Not found', { status: 404 }) : expired())
        return
    }
    let body = file.body
    if (file.type.startsWith('text/html') && typeof body === 'string') {
        body = body.includes('</body>') ? body.replace('</body>', PAGE_SCRIPT + '</body>') : body + PAGE_SCRIPT
    }
    event.respondWith(
        new Response(body, {
            status: 200,
            headers: {
                'Content-Type': file.type,
                'Cache-Control': 'no-store',
                // The preview's own policy: what a static host would give the site (nothing), plus
                // the sandbox that gives the document an opaque origin, so a theme's script runs
                // here with no reach into the app. The frame's own sandbox attribute has to allow
                // same-origin for this navigation to reach the worker at all; this is what takes
                // it away again.
                'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
                'X-Content-Type-Options': 'nosniff',
            },
        }),
    )
})
