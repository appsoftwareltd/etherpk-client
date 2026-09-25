/**
 * Content-Security-Policy directives for the three apps, built at config load time.
 *
 * CSP belongs in `kit.csp` rather than at the ingress: SvelteKit emits inline scripts of its
 * own and only it can nonce or hash them. It matters most on the Client,
 * where the key that decrypts every graph is held in `localStorage` and untrusted
 * document content is rendered through Mermaid and KaTeX. Without a CSP, one renderer escape
 * or one compromised dependency is a total disclosure of the account's encrypted data.
 *
 * `app.html` carries a hand-written inline script (the pre-paint theme bootstrap) which
 * SvelteKit does not know about and therefore does not hash. Rather than pasting a hash that
 * silently rots the next time somebody edits that script, {@link inlineScriptHashes} reads
 * the template and derives them. A nonce and a hash may both appear in `script-src`; a script
 * matching either is allowed.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The analytics script and the beacons it sends back. */
const ANALYTICS_ORIGIN = 'https://analytics.appsoftware.com'
const GOOGLE_FONTS_STYLESHEET_ORIGIN = 'https://fonts.googleapis.com'
const GOOGLE_FONTS_FILE_ORIGIN = 'https://fonts.gstatic.com'

/** Inline `<script>` blocks, ignoring those with a `src` (which `script-src 'self'` covers). */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g

/**
 * sha256 source expressions for every inline script in an `app.html`. Hashing the exact
 * bytes between the tags is what the CSP specification requires, so this must not normalise
 * whitespace.
 */
export function inlineScriptHashes(appHtmlPath: string): string[] {
    const template = readFileSync(appHtmlPath, 'utf8')
    return [...template.matchAll(INLINE_SCRIPT)].map(
        (match) => `sha256-${createHash('sha256').update(match[1]).digest('base64')}`,
    )
}

export interface CspOptions {
    /** Path to the app's `src/app.html`. */
    appHtmlPath: string
    /**
     * The Client talks to whichever Sync Server the user configured, which may be any
     * self-hosted origin, so it cannot pin `connect-src`. The Server and Corporate apps only
     * talk to themselves.
     */
    allowArbitrarySyncOrigins?: boolean
    /**
     * The Client renders documents that may embed images from anywhere on the web
     * (`![alt](https://…)`), which the base policy blocks. Only the Client sets this: the
     * Server and Corporate apps render no user documents. Loading a remote image tells its
     * host the reader's address and the time of reading, which is the ordinary trade every
     * markdown editor makes; the graph's own assets never leave the sync bucket and are
     * unaffected (`blob:`).
     */
    allowRemoteImages?: boolean
    /**
     * Development needs `ws:` for Vite's HMR socket and plain `http:` for a Sync Server on
     * localhost. Neither belongs in a production policy.
     */
    dev?: boolean
    /**
     * The deployment itself is served over plain HTTP on loopback names (docker/staging), so
     * its Sync Server is reached over `http:` / `ws:` and `http:` images are not mixed content.
     * Decided at build time because these directives are baked into the image; a production
     * image never sets it. Development implies it.
     */
    plaintext?: boolean
    /**
     * Admit the analytics host for its script and the beacons it sends. Only Corporate carries
     * the telemetry tag; the Client and the Sync Server load no third-party script, so their
     * policies never name the host (2026-09-19).
     */
    analytics?: boolean
}

export function cspDirectives(options: CspOptions): Record<string, string[]> {
    // blob: lets the app READ its own object URLs. Asset bytes already reach <img> and <video>
    // as blob: URLs (img-src / media-src below), and this is the same bytes through a different
    // API - pdf.js fetches the PDF it is given rather than being handed a buffer. A blob: URL is
    // same-origin, is minted by this app, and addresses nothing outside it, so allowing it here
    // exfiltrates nothing; refusing it only decided that an asset could be displayed but not
    // parsed. It is NOT a relaxation of the framing rule in ADR 0055 - frame-src and object-src
    // are untouched, and nothing is framed.
    const connectSrc = ["'self'", 'blob:']
    if (options.analytics) connectSrc.push(ANALYTICS_ORIGIN)
    if (options.allowArbitrarySyncOrigins) connectSrc.push('https:', 'wss:')
    if (options.dev || options.plaintext) connectSrc.push('ws:', 'http:')

    // blob: is how decrypted assets are handed to <img>; data: covers inline SVG icons. The
    // Client adds any HTTPS origin for images embedded from the web; plain http: images only
    // where the app itself is served over http (development), since a browser blocks them as
    // mixed content on an https page regardless of this policy.
    const imgSrc = ["'self'", 'data:', 'blob:']
    if (options.allowRemoteImages) {
        imgSrc.push('https:')
        if (options.dev || options.plaintext) imgSrc.push('http:')
    }

    return {
        'default-src': ["'self'"],
        // The inline hashes cover app.html's theme bootstrap; SvelteKit nonces its own.
        // 'wasm-unsafe-eval' is required by the SQLite build the document index runs on:
        // WebAssembly compilation is governed by script-src, and without it the index worker
        // never starts. It permits WASM compilation only, not eval() or new Function(), so it
        // is a far narrower grant than 'unsafe-eval'.
        'script-src': [
            "'self'",
            "'wasm-unsafe-eval'",
            ...(options.analytics ? [ANALYTICS_ORIGIN] : []),
            ...inlineScriptHashes(options.appHtmlPath),
        ],
        // 'unsafe-inline' for styles is deliberate and much weaker than the script equivalent:
        // Mermaid and KaTeX inject stylesheets at runtime, Svelte emits inline style
        // attributes, and app.html's own body wrapper carries one. Script injection is what
        // this policy exists to stop.
        'style-src': ["'self'", "'unsafe-inline'", GOOGLE_FONTS_STYLESHEET_ORIGIN],
        'font-src': ["'self'", GOOGLE_FONTS_FILE_ORIGIN, 'data:'],
        'img-src': imgSrc,
        'media-src': ["'self'", 'blob:'],
        'connect-src': connectSrc,
        // The import converter and the document index both run in bundled module workers.
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        // No form-action, deliberately.
        //
        // Chrome enforces it across a form submission's whole redirect chain, and managed sign
        // out is a same-origin form POST whose response redirects to Corporate's end-session
        // endpoint on another origin. 'self' therefore breaks global sign out in all three apps,
        // which the three-origin e2e suite demonstrated.
        //
        // It cannot be expressed correctly either: the federation partner's origin is runtime
        // configuration read from the environment, and these directives are built once when the
        // image is. Listing it would mean baking one deployment's Corporate origin into an image
        // meant to be self-hosted anywhere. 'self' https: would allow every HTTPS origin, which
        // buys almost nothing over omitting it.
        //
        // What form-action guards against is an injected form exfiltrating to an attacker
        // origin, and script-src above is what stops the injection in the first place.
    }
}
