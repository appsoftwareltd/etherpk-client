/**
 * Map pictures for a publish from the Headless Client (ADR 0118): a [[Map Block]] is published as
 * a picture of the map, never as its lines, and the picture is drawn in a real Chromium, the one
 * Mermaid diagrams use (diagrams.ts), because MapLibre needs WebGL and a page to draw in.
 *
 * The page runs the maps extension's own drawing code (`map-picture-page.js`, built from
 * `src/map-picture-page.ts` beside the Node bundle), so a map published from here looks as it
 * does published from the browser. It is served, with the MapLibre this package installs, from a
 * server on the loopback address that answers only those files, so MapLibre's worker loads as it
 * does in the Client. The basemap comes from EtherPK's map host, or the style
 * `ETHERPK_MAP_STYLE_URL` names; set empty, maps are drawn on a plain background.
 */
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MapPicture } from '$lib/document/publish/publish'
import { DEFAULT_MAP_STYLES } from '@appsoftwareltd/etherpk-extension-maps/picture'

import { launchChromium } from './diagrams'

const require = createRequire(import.meta.url)

/** The light basemap style a publish draws with, or null for a plain background. */
export function publishMapStyle(env: NodeJS.ProcessEnv): string | null {
    const named = env.ETHERPK_MAP_STYLE_URL
    if (named === undefined) return DEFAULT_MAP_STYLES.light
    return named.trim() === '' ? null : named.trim()
}

/** Whether a publish of these bodies draws a map: a fenced block whose info string is `map`. */
export function needsMaps(bodies: Iterable<string>): boolean {
    for (const body of bodies) if (/^\s*(?:-\s+)?```map\s*$/m.test(body)) return true
    return false
}

/** The page: MapLibre by the import map, then the drawing code, which puts its function on `window`. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"maplibre-gl":"/maplibre-gl.mjs"}}</script>
<script type="module" src="/map-picture-page.js"></script>
</head><body></body></html>`

/** The files the page loads, by path, and where each is on disk. */
function pageFiles(): Map<string, string> {
    const maplibre = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'))
    // Beside this module in the published package (dist/), or in dist/ when run from source.
    const here = dirname(fileURLToPath(import.meta.url))
    const bundle = here.endsWith('dist') ? join(here, 'map-picture-page.js') : join(here, '..', 'dist', 'map-picture-page.js')
    return new Map([
        ['/maplibre-gl.mjs', join(maplibre, 'maplibre-gl.mjs')],
        ['/maplibre-gl-shared.mjs', join(maplibre, 'maplibre-gl-shared.mjs')],
        ['/maplibre-gl-worker.mjs', join(maplibre, 'maplibre-gl-worker.mjs')],
        ['/map-picture-page.js', bundle],
    ])
}

/** A server on the loopback address that answers the page and its files, and nothing else. */
async function servePage(): Promise<{ server: Server; origin: string }> {
    const files = pageFiles()
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (path === '/map.html') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE)
            return
        }
        const file = files.get(path)
        if (!file) {
            response.writeHead(404).end()
            return
        }
        readFile(file).then(
            (bytes) => response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(bytes),
            () => response.writeHead(404).end(),
        )
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The map page server has no port.')
    return { server, origin: `http://127.0.0.1:${address.port}` }
}

export interface MapPictureRenderer {
    /** A Map Block's body to its picture; rejects with why it could not be drawn. */
    render(source: string): Promise<MapPicture>
    dispose(): Promise<void>
}

/**
 * A renderer over one headless browser, opened for a publish and closed after it. Null when no
 * browser is available; the caller decides what that means (a publish with maps refuses).
 */
export async function openMapRenderer(env: NodeJS.ProcessEnv): Promise<MapPictureRenderer | null> {
    const browser = await launchChromium(env)
    if (!browser) return null
    const style = publishMapStyle(env)
    let served: { server: Server; origin: string } | null = null
    let pagePromise: Promise<import('playwright-core').Page> | undefined
    const page = () => {
        pagePromise ??= (async () => {
            served = await servePage()
            const p = await (await browser.newContext()).newPage()
            await p.goto(`${served.origin}/map.html`)
            await p.waitForFunction(() => typeof window.etherpkDrawMapPicture === 'function', undefined, { timeout: 15_000 })
            return p
        })()
        return pagePromise
    }
    return {
        async render(source) {
            const p = await page()
            const drawn = await p.evaluate(
                async ([text, basemap]) => {
                    const picture = await window.etherpkDrawMapPicture!(text, { style: basemap })
                    // Carried out as base64: a byte array crosses as a list of numbers, ten times the size.
                    let binary = ''
                    for (const byte of picture.bytes) binary += String.fromCharCode(byte)
                    return { type: picture.type, width: picture.width, height: picture.height, data: btoa(binary) }
                },
                [source, style] as const,
            )
            return { type: drawn.type, width: drawn.width, height: drawn.height, bytes: new Uint8Array(Buffer.from(drawn.data, 'base64')) }
        },
        async dispose() {
            await browser.close().catch(() => {})
            const open = served as { server: Server } | null
            await new Promise<void>((resolve) => (open ? open.server.close(() => resolve()) : resolve()))
        },
    }
}
