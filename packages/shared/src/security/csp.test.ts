import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cspDirectives, inlineScriptHashes } from './csp'

function appHtml(body: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'csp-')), 'app.html')
    writeFileSync(path, body)
    return path
}

const THEME_SCRIPT = '\n  document.documentElement.dataset.theme = "dark"\n'

describe('inlineScriptHashes', () => {
    it('hashes the exact bytes between the script tags', () => {
        const path = appHtml(`<head><script>${THEME_SCRIPT}</script></head>`)
        const expected = `sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}`
        expect(inlineScriptHashes(path)).toEqual([expected])
    })

    it('ignores scripts loaded from a src, which script-src self already covers', () => {
        const path = appHtml('<head><script defer src="https://example.test/a.js"></script></head>')
        expect(inlineScriptHashes(path)).toEqual([])
    })

    it('hashes every inline script, not only the first', () => {
        const path = appHtml('<head><script>a()</script><script>b()</script></head>')
        expect(inlineScriptHashes(path)).toHaveLength(2)
    })

    it('tracks an edit to the template rather than going stale', () => {
        const before = inlineScriptHashes(appHtml('<script>a()</script>'))
        const after = inlineScriptHashes(appHtml('<script>a() // changed</script>'))
        expect(before).not.toEqual(after)
    })
})

describe('cspDirectives', () => {
    const path = appHtml(`<head><script>${THEME_SCRIPT}</script></head>`)

    it('allows only same-origin scripts and the template hash', () => {
        const scriptSrc = cspDirectives({ appHtmlPath: path })['script-src']
        expect(scriptSrc).toContain("'self'")
        expect(scriptSrc).not.toContain('https://analytics.appsoftware.com')
        expect(scriptSrc.some((source) => source.startsWith('sha256-'))).toBe(true)
        expect(scriptSrc).not.toContain("'unsafe-inline'")
        expect(scriptSrc).not.toContain("'unsafe-eval'")
    })

    it('admits the analytics host for its script and beacons only where an app asks for it', () => {
        // Only Corporate carries the telemetry tag (2026-09-19); the Client and the Sync Server
        // load no third-party script at all, and their policies say so.
        const directives = cspDirectives({ appHtmlPath: path, analytics: true })
        expect(directives['script-src']).toContain('https://analytics.appsoftware.com')
        expect(directives['connect-src']).toContain('https://analytics.appsoftware.com')
    })

    it('allows WebAssembly compilation, which the SQLite document index needs', () => {
        // Narrower than 'unsafe-eval': it permits WASM compilation and nothing else.
        expect(cspDirectives({ appHtmlPath: path })['script-src']).toContain("'wasm-unsafe-eval'")
    })

    it('forbids plugins, base tag rewriting and framing', () => {
        const directives = cspDirectives({ appHtmlPath: path })
        expect(directives['object-src']).toEqual(["'none'"])
        expect(directives['base-uri']).toEqual(["'self'"])
        expect(directives['frame-ancestors']).toEqual(["'none'"])
    })

    it('sets no form-action, which would break cross-origin managed sign out', () => {
        // Chrome enforces form-action across a form POST's redirect chain, and managed sign out
        // is a same-origin POST that redirects to Corporate. See the note in csp.ts.
        expect(cspDirectives({ appHtmlPath: path })['form-action']).toBeUndefined()
    })

    it('pins connect-src to the app itself when it only talks to itself', () => {
        const connectSrc = cspDirectives({ appHtmlPath: path })['connect-src']
        expect(connectSrc).toEqual(["'self'", 'blob:'])
    })

    it('lets the app read its own object URLs, which an asset viewer needs', () => {
        // Asset bytes already reach <img> and <video> as blob: URLs; a viewer that PARSES them
        // (pdf.js fetches the file it is given) goes through connect-src instead. Without this
        // the PDF tab could not read the file at all. A blob: URL is same-origin and addresses
        // nothing outside the app, so this grants no reach it did not already have.
        expect(cspDirectives({ appHtmlPath: path })['connect-src']).toContain('blob:')
        // And it is NOT a way back to framing: ADR 0055's directives are untouched.
        expect(cspDirectives({ appHtmlPath: path })['object-src']).toEqual(["'none'"])
        expect(cspDirectives({ appHtmlPath: path })['frame-src']).toBeUndefined()
    })

    it('opens connect-src to any HTTPS origin for the Client, whose Sync Server is configurable', () => {
        const connectSrc = cspDirectives({ appHtmlPath: path, allowArbitrarySyncOrigins: true })['connect-src']
        expect(connectSrc).toContain('https:')
        expect(connectSrc).toContain('wss:')
    })

    it('adds the plain-text schemes only in development', () => {
        expect(cspDirectives({ appHtmlPath: path, dev: true })['connect-src']).toContain('ws:')
        expect(cspDirectives({ appHtmlPath: path })['connect-src']).not.toContain('ws:')
    })

    it('adds the plain-text schemes for a plain-HTTP loopback deployment too', () => {
        // docker/staging serves the Client over http on *.localhost names; its CSP is baked at
        // build time, so the build has to be told that its Sync Server is http:/ws: as well.
        const directives = cspDirectives({
            appHtmlPath: path,
            allowArbitrarySyncOrigins: true,
            allowRemoteImages: true,
            plaintext: true,
        })
        expect(directives['connect-src']).toContain('http:')
        expect(directives['connect-src']).toContain('ws:')
        expect(directives['img-src']).toContain('http:')
    })

    it('keeps img-src to the app, data: and blob: unless remote images are asked for', () => {
        expect(cspDirectives({ appHtmlPath: path })['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    })

    it('opens img-src to any HTTPS origin for the Client, whose documents may embed images from the web', () => {
        const imgSrc = cspDirectives({ appHtmlPath: path, allowRemoteImages: true })['img-src']
        expect(imgSrc).toContain('https:')
        expect(imgSrc).toContain('blob:')
        expect(imgSrc).not.toContain('http:')
    })

    it('adds plain http: images only in development, where the app itself is served over http', () => {
        expect(cspDirectives({ appHtmlPath: path, allowRemoteImages: true, dev: true })['img-src']).toContain('http:')
        expect(cspDirectives({ appHtmlPath: path, dev: true })['img-src']).not.toContain('http:')
    })

    it('allows the module workers the importer and the document index run in', () => {
        expect(cspDirectives({ appHtmlPath: path })['worker-src']).toEqual(["'self'", 'blob:'])
    })
})
