/**
 * The publisher's environment in the browser (ADR 0082): Mermaid pre-rendered by the app's own
 * renderer (so a diagram on the site is drawn by the same version that draws it in the editor),
 * a Map Block drawn as a picture by whatever extension contributed one (ADR 0118, ADR 0121), KaTeX's stylesheet and fonts fetched from the app's own bundle to be copied into the
 * site, and themes fetched over the network. Browser-only; the Headless Client has its own.
 *
 * An extension's fence is published as whatever its `publish` returns, an SVG picture cleaned first
 * (`security/svg-file.ts`). Only here do extensions run, so only here are SVG pictures made.
 */

import katexCss from 'katex/dist/katex.min.css?raw'

import { cleanedSvgFile } from '../../../security/svg-file'

import { mermaidRenderer } from '../../view/augmentations/renderers/mermaid-renderer'
import type { MapPictureRenderer } from '../map-picture-renderer'
import type { PublishedFenceOutput, PublishEnvironment } from '../publish'
import type { GraphTheme } from '../theme/graph-theme'
import { createThemeLoader } from '../theme/sources'
import { decodeDataUrl } from './data-url'

/**
 * The woff2 faces the stylesheet names; browsers take the first source they support, and every
 * current one supports woff2. Lazy, so the fonts are only fetched for a publish that has maths,
 * and `?url` rather than `?inline` so the workspace's chunk does not carry them base64-encoded.
 * Vite still inlines the smallest as `data:` urls, which {@link bytesOf} decodes rather than
 * fetches: a deployed Client's CSP refuses a fetch of one.
 */
const fontUrls = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', { query: '?url', import: 'default' })

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return response.text()
}

/** An asset's bytes by url: decoded when the build inlined it, fetched from the bundle otherwise. */
async function bytesOf(url: string, name: string): Promise<Uint8Array> {
    const inlined = decodeDataUrl(url)
    if (inlined) return inlined
    const response = await fetch(url)
    if (!response.ok) throw new Error(`KaTeX font ${name}: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

let katexAssetsPromise: Promise<Map<string, string | Uint8Array>> | null = null

/** `katex.min.css` plus its woff2 fonts under `fonts/`, as the stylesheet references them. */
async function katexAssets(): Promise<Map<string, string | Uint8Array>> {
    if (!katexAssetsPromise) {
        katexAssetsPromise = (async () => {
            const out = new Map<string, string | Uint8Array>([['katex.min.css', katexCss]])
            for (const [path, load] of Object.entries(fontUrls)) {
                const name = path.slice(path.lastIndexOf('/') + 1)
                const url = await load()
                if (typeof url !== 'string' || url === '') throw new Error(`KaTeX font ${name}: no url in this build`)
                out.set(`fonts/${name}`, await bytesOf(url, name))
            }
            return out
        })().catch((error) => {
            katexAssetsPromise = null
            throw error
        })
    }
    return katexAssetsPromise
}

/** An extension's answer with an SVG picture cleaned for the site; any other answer as it is. */
function cleanedPicture(out: PublishedFenceOutput | null): PublishedFenceOutput | null {
    // Anything not a picture's bytes is checked, and refused, by the publisher.
    if (out?.kind !== 'picture' || out.type !== 'image/svg+xml' || !(out.bytes instanceof Uint8Array)) return out
    const svg = cleanedSvgFile(new TextDecoder().decode(out.bytes))
    if (svg === null) throw new Error('its picture is not an SVG file the Client could check')
    return { ...out, bytes: new TextEncoder().encode(svg) }
}

export interface BrowserEnvironmentDeps {
    /** The graph's theme container lookup. */
    graphTheme(id: string): Promise<GraphTheme | null>
    /**
     * What draws a Map Block as a picture, read as a publish needs one: the renderer an extension
     * contributed (`map-picture-renderer.ts`), or undefined when none did.
     */
    mapPicture?(): MapPictureRenderer | undefined
    /**
     * The `publish` of whatever extension draws fences of this info word (its fence registration),
     * read as a publish needs it, or undefined when none does.
     */
    fencePublisher?(info: string): ((fence: { info: string; body: readonly string[]; document: string }) => PublishedFenceOutput | null | Promise<PublishedFenceOutput | null>) | undefined
}

export function createBrowserPublishEnvironment(deps: BrowserEnvironmentDeps): PublishEnvironment {
    return {
        loadTheme: createThemeLoader({ fetchText, graphTheme: deps.graphTheme }),
        async renderMermaid(source) {
            const element = await mermaidRenderer.render(source, { dark: false })
            const svg = element.querySelector('svg')
            if (!svg) throw new Error('Mermaid produced no diagram.')
            // The site has no Mermaid runtime, so the element must stand on its own. It keeps the
            // id the renderer minted: every rule of its inline <style> is scoped to that id, and
            // without it the node rects fall back to SVG's default black fill. The publisher
            // renames it to one unique on the page (publish/diagram-id.ts).
            svg.setAttribute('role', 'img')
            return svg.outerHTML
        },
        async renderMap(source) {
            const draw = deps.mapPicture?.()
            // A browser can draw maps, so the publish is told why this one did not, and what to do.
            if (!draw) throw new Error('no extension on this device draws maps. Check that Maps is switched on under Settings > Extensions')
            return draw(source)
        },
        publishFence(fence) {
            const publish = deps.fencePublisher?.(fence.info)
            if (!publish) return undefined
            // Whatever the extension does, the publisher gets a promise it can wait on and catch.
            return (async () => cleanedPicture(await publish(fence)))()
        },
        katexAssets,
    }
}
