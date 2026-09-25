/**
 * The publisher's environment in the browser (ADR 0082): Mermaid pre-rendered by the app's own
 * renderer (so a diagram on the site is drawn by the same version that draws it in the editor),
 * KaTeX's stylesheet and fonts fetched from the app's own bundle to be copied into the site,
 * and themes fetched over the network. Browser-only; the Headless Client has its own.
 */

import katexCss from 'katex/dist/katex.min.css?raw'

import { mermaidRenderer } from '../../view/augmentations/renderers/mermaid-renderer'
import type { PublishEnvironment } from '../publish'
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

export interface BrowserEnvironmentDeps {
    /** The graph's theme container lookup. */
    graphTheme(id: string): Promise<GraphTheme | null>
}

export function createBrowserPublishEnvironment(deps: BrowserEnvironmentDeps): PublishEnvironment {
    return {
        loadTheme: createThemeLoader({ fetchText, graphTheme: deps.graphTheme }),
        async renderMermaid(source) {
            const element = await mermaidRenderer.render(source, { dark: false })
            const svg = element.querySelector('svg')
            if (!svg) throw new Error('Mermaid produced no diagram.')
            // The site has no Mermaid runtime, so the element must stand on its own: drop the
            // id the renderer minted (it collides across pages) and size to the container.
            svg.removeAttribute('id')
            svg.setAttribute('role', 'img')
            return svg.outerHTML
        },
        katexAssets,
    }
}
