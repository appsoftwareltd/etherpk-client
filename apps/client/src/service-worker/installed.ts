/**
 * The service worker of a desktop Native App. It hosts the Theme editor's preview and does
 * nothing else.
 *
 * The preview needs one: a response of its own is what gives the preview's page a policy of its own,
 * and the shell serves only the files it was packaged with. The rest of `index.ts` is for a Client
 * served over a network. Every file of a Native App is on the device already, a share and an
 * opened file arrive through the shell, and a kept page would outlive an update of the app.
 *
 * `scripts/build-installed.mjs` bundles this to `service-worker.js`, the address the Client's own
 * worker has. The Android app registers none (a WebView asks its shell for a worker's requests
 * separately), and its preview shows the page without running the theme's scripts.
 */
import { PREVIEW_PREFIX, keepPostedPreviews, previewResponse } from './theme-preview'

const sw = self as unknown as ServiceWorkerGlobalScope

keepPostedPreviews(sw)

sw.addEventListener('install', (event) => event.waitUntil(sw.skipWaiting()))
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()))
sw.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    if (url.href.startsWith(`${sw.location.origin}${PREVIEW_PREFIX}`)) event.respondWith(previewResponse(url))
})
