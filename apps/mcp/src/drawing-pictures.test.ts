import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { chromiumOnThisMachine, WARM_UP_TIMEOUT } from './chromium-fixture'
import { launchChromium } from './diagrams'
import { type DrawingRenderer, needsDrawings, openDrawingRenderer } from './drawing-pictures'
import { createNodePublishEnvironment } from './publish-environment'

// A drawing published from the Headless Client is a picture drawn in a real Chromium by the
// Excalidraw extension's own code (ADR 0175). The drawing half runs where this machine has a Chromium.

const HEADER = '{"type":"excalidraw.drawing","version":1,"id":"k3j9x2q8ab","background":"#ffffff"}'
const BOX = '{"type":"rectangle","x":0,"y":0,"width":120,"height":60}'
const LABEL = '{"type":"text","x":10,"y":10,"text":"Raised beds"}'

describe('which publishes draw drawings', () => {
    it('is any whose pages hold a drawing fence, in prose or on a bullet', () => {
        expect(needsDrawings(['Intro\n\n```excalidraw.drawing\n{}\n```\n'])).toBe(true)
        expect(needsDrawings(['- Plan\n  ```excalidraw.drawing\n  {}\n  ```'])).toBe(true)
        expect(needsDrawings(['- ```excalidraw.drawing\n  {}\n  ```'])).toBe(true)
        expect(needsDrawings(['````excalidraw.drawing\n{}\n````'])).toBe(true)
    })

    it('is not one that only mentions them, or holds a fence of another extension', () => {
        expect(needsDrawings(['Draw with `excalidraw.drawing`', '```js\nconst drawing = 1\n```', '```excalidraw.other\n{}\n```', '```ink.drawing\n{}\n```'])).toBe(false)
    })
})

describe('the publish environment', () => {
    const picture = { kind: 'picture' as const, type: 'image/svg+xml' as const, bytes: new Uint8Array([1]), width: 1, height: 1, alt: 'Drawing' }
    const drawings: DrawingRenderer = { render: () => Promise.resolve(picture), dispose: () => Promise.resolve() }
    const fence = (info: string) => ({ info, body: [HEADER], document: 'Garden' })
    const graphTheme = () => Promise.resolve(null)

    it('hands a drawing fence to the renderer', async () => {
        await expect(createNodePublishEnvironment({ graphTheme, drawings }).publishFence?.(fence('excalidraw.drawing'))).resolves.toBe(picture)
    })

    it("publishes no other extension's fence, which the publisher then leaves out", () => {
        expect(createNodePublishEnvironment({ graphTheme, drawings }).publishFence?.(fence('garden.plan'))).toBeUndefined()
        expect(createNodePublishEnvironment({ graphTheme, drawings }).publishFence?.(fence('ink.drawing'))).toBeUndefined()
    })

    it('publishes no drawing without a renderer', () => {
        expect(createNodePublishEnvironment({ graphTheme }).publishFence?.(fence('excalidraw.drawing'))).toBeUndefined()
    })
})

const chromium = chromiumOnThisMachine()

describe.skipIf(!chromium)('drawing a picture in Chromium', () => {
    let renderer: DrawingRenderer | null = null

    beforeAll(async () => {
        // The page a publish serves is built with the package; built here for the test. Bundling
        // Excalidraw and a browser's first launch are first-time costs, kept off the tests' timers.
        const { build } = await import('vite')
        const root = join(dirname(fileURLToPath(import.meta.url)), '..')
        await build({ configFile: join(root, 'vite.drawing-page.config.ts'), root, logLevel: 'error' })
        renderer = await openDrawingRenderer({ ...process.env, ETHERPK_CHROMIUM: chromium! })
        await renderer!.render([HEADER, BOX])
    }, WARM_UP_TIMEOUT)

    afterAll(async () => {
        await renderer?.dispose()
    })

    it('draws shapes as an SVG file with a size and the words as its alt text', async () => {
        const out = await renderer!.render([HEADER, BOX, LABEL])
        if (out?.kind !== 'picture') throw new Error('no picture')
        expect(out.type).toBe('image/svg+xml')
        expect(out.width).toBeGreaterThan(100)
        expect(out.height).toBeGreaterThan(50)
        expect(out.alt).toContain('Raised beds')
        const svg = new TextDecoder().decode(out.bytes)
        expect(svg).toContain('<svg')
        expect(svg).toContain('Raised beds')
    })

    it('holds the fonts its words use, so the file stands on its own', async () => {
        const out = await renderer!.render([HEADER, LABEL])
        if (out?.kind !== 'picture') throw new Error('no picture')
        const svg = new TextDecoder().decode(out.bytes)
        expect(svg).toContain('@font-face')
        expect(svg).toContain('data:font/woff2')
        expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    })

    it('measures hand-written words in their own font, so none runs past the picture', async () => {
        const words = '{"type":"text","x":0,"y":0,"text":"Water the beans before the frost comes","fontFamily":5,"fontSize":24}'
        const out = await renderer!.render([HEADER, words])
        if (out?.kind !== 'picture') throw new Error('no picture')
        const browser = await launchChromium({ ...process.env, ETHERPK_CHROMIUM: chromium! })
        try {
            const page = await browser!.newPage()
            await page.setContent(new TextDecoder().decode(out.bytes))
            const { edge, width } = await page.evaluate(async () => {
                await document.fonts.ready
                await Promise.all([...document.fonts].map((font) => font.load()))
                const svg = document.querySelector('svg')!
                const text = svg.querySelector('text')!
                return { edge: text.getBoundingClientRect().right - svg.getBoundingClientRect().left, width: svg.getBoundingClientRect().width }
            })
            expect(edge).toBeLessThanOrEqual(width)
        } finally {
            await browser!.close()
        }
    })

    it('cleans the picture as the Client does: no script', async () => {
        const out = await renderer!.render([HEADER, '{"type":"text","x":0,"y":0,"text":"<script>alert(1)</script>"}'])
        if (out?.kind !== 'picture') throw new Error('no picture')
        expect(new TextDecoder().decode(out.bytes)).not.toContain('<script')
    })

    it('answers nothing for a drawing with nothing in it', async () => {
        await expect(renderer!.render([HEADER])).resolves.toBeNull()
    })
})
