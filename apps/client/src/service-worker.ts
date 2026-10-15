/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
/**
 * The Client's service worker (ADR 0142). It does three things:
 *
 * 1. **Starts the app with no network.** Each version's files (the build's hashed files and the
 *    icons and manifest) are cached when the worker installs, and served from that cache. An app
 *    page that cannot be fetched is answered with the shell (`app-shell.ts`), which hands the
 *    address to the router, so a reload or a cold start offline opens the app, and the graph
 *    then opens from this device (ADR 0141).
 * 2. **Keeps extension files.** A file under `/extensions/` is fetched from the network first, so
 *    a release taken out of the directory is still refused, and kept for use offline.
 * 3. **Hosts the Theme editor's preview** (ADR 0082), unchanged from before.
 *
 * Every other request is not answered here at all: no `respondWith`, so the browser handles it
 * exactly as if there were no worker. `respondWith(fetch(request))` is NOT a pass-through. It
 * turns a transient failure into a hard network error, and it once broke the index worker's
 * wasm load and downgraded the persisted index to memory (2026-07-28). The files this worker does
 * answer come from the Cache API with the headers they were served with, `application/wasm`
 * included.
 *
 * In development `build` is empty and pages change on every edit, so only the preview runs.
 */
import { build, files, version } from '$service-worker'
import {
    BUILT_IN_EXTENSION_FILES,
    EXTENSION_CACHE,
    SHELL_PATH,
    appCacheName,
    appCachesToDelete,
    extensionFileStatus,
    isAppPagePath,
    isImmutableAppFile,
    isWorkerScript,
    referencedAppFiles,
    shellMatchesBuild,
} from '$lib/offline/app-shell'

const sw = self as unknown as ServiceWorkerGlobalScope

// SvelteKit documents `build` as empty in development. `import.meta.env.DEV` is not usable here:
// SvelteKit's build of this worker compiles it to true.
const DEV = build.length === 0
const APP_CACHE = appCacheName(version)
/** How long an app page may take before the shell is served in its place. */
const PAGE_DEADLINE_MS = 5_000
/** The static files the app needs to look like itself; the rest (the demo graph, marketing images) stay on the server. */
const SHELL_FILES = new Set(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/site.webmanifest'])
/** Every file this version caches, by path. */
const APP_FILES = new Set([...build, ...files.filter((file) => SHELL_FILES.has(file))])

sw.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            if (!DEV) await cacheAppFiles()
            // Take over at once. The cache made before this one is kept (appCachesToDelete), so
            // a tab still running that version keeps its files.
            await sw.skipWaiting()
        })(),
    )
})

sw.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            for (const key of appCachesToDelete(await caches.keys(), APP_CACHE)) await caches.delete(key)
            await sw.clients.claim()
        })(),
    )
})

/**
 * Cache this version's files, then its shell. A file an earlier version cached already has the
 * same contents, because its name carries its hash, so only new files are downloaded. One file
 * that cannot be fetched fails the install, and the worker before stays in charge: a version that
 * could not start offline must not replace one that can.
 */
async function cacheAppFiles(): Promise<void> {
    const cache = await caches.open(APP_CACHE)
    await cacheFiles(cache, [...APP_FILES, ...(await builtInExtensionFiles())])
    // The files web workers load are not on the build's list, but each worker's script names them.
    const workerFiles = new Set<string>()
    for (const script of [...APP_FILES].filter(isWorkerScript)) {
        const text = await (await cache.match(script))?.text()
        for (const file of referencedAppFiles(text ?? '')) if (!APP_FILES.has(file)) workerFiles.add(file)
    }
    await cacheFiles(cache, [...workerFiles])
    // The shell is not worth failing the install for: the next app page refreshes it.
    await refreshShell().catch(() => {})
}

/**
 * Put each file in `cache`, a few at a time: the build is over four hundred files, and the app is
 * in use meanwhile. A file an earlier version cached is copied from there.
 */
async function cacheFiles(cache: Cache, files: string[]): Promise<void> {
    const pending = [...files]
    const worker = async () => {
        for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
            if (await cache.match(file)) continue
            const earlier = await caches.match(file)
            if (earlier) {
                await cache.put(file, earlier)
                continue
            }
            const response = await fetch(file)
            if (!response.ok) throw new Error(`could not cache ${file}: HTTP ${response.status}`)
            await cache.put(file, response)
        }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
}

/** The files this version ships for its loaded Built-in Extensions, from the list its build wrote. */
async function builtInExtensionFiles(): Promise<string[]> {
    const response = await fetch(BUILT_IN_EXTENSION_FILES)
    if (!response.ok) throw new Error(`could not read ${BUILT_IN_EXTENSION_FILES}: HTTP ${response.status}`)
    const list: unknown = await response.json()
    return Array.isArray(list) ? list.filter((file): file is string => typeof file === 'string' && file.startsWith('/extensions/')) : []
}

/** Fetch the shell, and keep it when it starts this version. Its layout data follows the person's cookies. */
async function refreshShell(): Promise<void> {
    const response = await fetch(SHELL_PATH, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return
    const html = await response.clone().text()
    if (!shellMatchesBuild(html, APP_FILES)) {
        // The server runs a newer version than this worker. Its own worker will cache its shell.
        void sw.registration.update().catch(() => {})
        return
    }
    await (await caches.open(APP_CACHE)).put(SHELL_PATH, response)
}

/**
 * An app page from the network, or the shell when the network fails or is too slow. This
 * version's shell first, else the one before, whose files are kept with it.
 */
async function appPage(event: FetchEvent): Promise<Response> {
    const shell = (await caches.match(SHELL_PATH, { cacheName: APP_CACHE })) ?? (await caches.match(SHELL_PATH))
    if (!shell) return fetch(event.request)
    try {
        const response = await withDeadline(fetch(event.request), PAGE_DEADLINE_MS)
        if (response.ok) event.waitUntil(refreshShell().catch(() => {}))
        return response
    } catch {
        return shell
    }
}

/**
 * An app file from this version's cache, else an older one's, else the network. A hashed file
 * the install did not find is kept when it is first fetched here.
 */
async function appFile(request: Request): Promise<Response> {
    const cached = (await caches.match(request, { cacheName: APP_CACHE })) ?? (await caches.match(request))
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && isImmutableAppFile(new URL(request.url).pathname)) {
        await (await caches.open(APP_CACHE)).put(request, response.clone())
    }
    return response
}

/**
 * A Built-in Extension's file from this version's cache. Any other extension file (a release
 * installed from the directory) from the network, kept for offline use; the kept copy when the
 * network fails.
 */
async function extensionFile(request: Request): Promise<Response> {
    const builtIn = await caches.match(request, { cacheName: APP_CACHE })
    if (builtIn) return builtIn
    const cache = await caches.open(EXTENSION_CACHE)
    let response: Response
    try {
        response = await fetch(request)
    } catch (error) {
        const kept = await cache.match(request.url)
        if (kept) return kept
        throw error
    }
    // The worker's own fetch goes through the browser's HTTP cache, which answers the server's 304
    // with the body it holds, so a file the server still lists arrives here as a 200.
    const status = extensionFileStatus(response.status)
    if (status === 'keep') await cache.put(request.url, response.clone())
    else if (status === 'forget') await cache.delete(request.url)
    return response
}

function withDeadline<T>(request: Promise<T>, deadlineMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), deadlineMs)
    })
    return Promise.race([request, deadline]).finally(() => clearTimeout(timer))
}

/* ------------------------------------------------------------------------------------------- */
/* The Theme editor's preview (ADR 0082).                                                        */
/* ------------------------------------------------------------------------------------------- */

/*
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
 */

const PREVIEW_PREFIX = '/__etherpk-preview/'

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

sw.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; id?: unknown; files?: unknown } | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'etherpk-preview-set' && typeof data.id === 'string' && Array.isArray(data.files)) {
        const bundle = new Map<string, { body: string | Uint8Array; type: string }>()
        for (const entry of data.files as unknown[]) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
            bundle.set(entry[0], { body: entry[1] as string | Uint8Array, type: mimeOf(entry[0]) })
        }
        previews.set(data.id, bundle)
        event.ports[0]?.postMessage({ ok: true })
    } else if (data.type === 'etherpk-preview-clear' && typeof data.id === 'string') {
        previews.delete(data.id)
    }
})

function expired(): Response {
    return new Response(
        '<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#374151"><p>This preview has expired (the browser restarted its background worker). Press <strong>Update preview</strong> to render it again.</p></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
}

async function preview(url: URL): Promise<Response> {
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

/* ------------------------------------------------------------------------------------------- */
/* Which requests this worker answers. Anything not named here is left to the browser.          */
/* ------------------------------------------------------------------------------------------- */

sw.addEventListener('fetch', (event) => {
    const request = event.request
    const url = new URL(request.url)
    if (url.origin !== sw.location.origin) return
    if (url.pathname.startsWith(PREVIEW_PREFIX)) {
        event.respondWith(preview(url))
        return
    }
    if (request.method !== 'GET' || DEV) return
    if (APP_FILES.has(url.pathname) || isImmutableAppFile(url.pathname)) {
        event.respondWith(appFile(request))
    } else if (request.mode === 'navigate' && isAppPagePath(url.pathname)) {
        event.respondWith(appPage(event))
    } else if (url.pathname.startsWith('/extensions/')) {
        event.respondWith(extensionFile(request))
    }
})
