/**
 * Drawing pictures for a publish from the Headless Client (ADR 0175): a [[Drawing]] is published as
 * a picture, never as its lines, and the picture is drawn in a real Chromium, the one Mermaid
 * diagrams use (diagrams.ts), because Excalidraw's export needs a page to measure text and load
 * fonts in. No page of this kind can reach the graph, so the images a drawing names are read here and
 * handed in, as a publish reads any other asset.
 *
 * The page runs the Excalidraw extension's own code (`drawing-page/`, built from
 * `src/drawing-picture-page.ts` beside the Node bundle), and is served, with Excalidraw's chunks and
 * fonts, from a server on the loopback address (page-server.ts).
 */
import { Buffer } from 'node:buffer'
import type { Server } from 'node:http'

import type { PublishedFenceOutput } from '#lib/document/publish/publish.js'
import type { PublishSource } from '#lib/document/publish/types.js'
import { assetNameFromRef, mimeTypeForExt, splitNameExt } from '#lib/storage/fs/asset-store.js'
import { DRAWING_FENCE, imageReferences } from '@appsoftwareltd/etherpk-extension-excalidraw/format'

import { launchChromium } from './diagrams'
import { builtPath, filesUnder, servePage } from './page-server'

/** Whether a publish of these bodies draws a drawing: a fenced block whose info string is the drawing fence's. */
export function needsDrawings(bodies: Iterable<string>): boolean {
    const fence = new RegExp(`^\\s*(?:-\\s+)?\`{3,}${DRAWING_FENCE.replace('.', '\\.')}\\s*$`, 'm')
    for (const body of bodies) if (fence.test(body)) return true
    return false
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script type="module" src="/drawing-picture-page.js"></script>
</head><body></body></html>`

export interface DrawingRenderer {
    /** A drawing fence's lines to its picture, or null when it holds nothing; rejects with why it could not be drawn. */
    render(body: readonly string[]): Promise<PublishedFenceOutput | null>
    dispose(): Promise<void>
}

/**
 * The images a drawing names, as data URLs by reference, leaving out any that cannot be read. Its type
 * comes from its name, since a data URL drawn in the picture must not say anything but an image.
 */
export async function drawingImages(body: readonly string[], readAsset: PublishSource['readAsset']): Promise<Record<string, string>> {
    const images: Record<string, string> = {}
    for (const ref of imageReferences(body)) {
        const type = mimeTypeForExt(splitNameExt(assetNameFromRef(ref) ?? '').ext)
        if (!type.startsWith('image/')) continue
        const asset = await readAsset(ref).catch(() => null)
        if (asset) images[ref] = `data:${type};base64,${Buffer.from(asset.bytes).toString('base64')}`
    }
    return images
}

/**
 * A renderer over one headless browser, opened for a publish and closed after it. Null when no
 * browser is available; the caller decides what that means (a publish with drawings refuses).
 */
export async function openDrawingRenderer(env: NodeJS.ProcessEnv, readAsset: PublishSource['readAsset']): Promise<DrawingRenderer | null> {
    const browser = await launchChromium(env)
    if (!browser) return null
    let served: { server: Server; origin: string } | null = null
    let pagePromise: Promise<import('playwright-core').Page> | undefined
    const page = () => {
        pagePromise ??= (async () => {
            served = await servePage(PAGE, await filesUnder(builtPath('drawing-page')))
            const p = await (await browser.newContext()).newPage()
            await p.goto(`${served.origin}/page.html`)
            await p.waitForFunction(() => typeof window.etherpkDrawDrawingPicture === 'function', undefined, { timeout: 15_000 })
            return p
        })()
        return pagePromise
    }
    return {
        async render(body) {
            const p = await page()
            const images = await drawingImages(body, readAsset)
            const drawn = await p.evaluate(([lines, held]) => window.etherpkDrawDrawingPicture!(lines, held), [[...body], images] as const)
            if (drawn === null) return null
            return { kind: 'picture', type: drawn.type, width: drawn.width, height: drawn.height, alt: drawn.alt, bytes: new Uint8Array(Buffer.from(drawn.data, 'base64')) }
        },
        async dispose() {
            await browser.close().catch(() => {})
            const open = served as { server: Server } | null
            await new Promise<void>((resolve) => (open ? open.server.close(() => resolve()) : resolve()))
        },
    }
}
