/**
 * The `mermaid` Augmentation renderer (ADR 0022): mermaid v11, bundled but LAZY — the dynamic
 * import happens inside the first render() call, so a graph with no diagrams never pays the
 * ~1.5MB (the lazy boundary sits exactly where the Contribution Point contract promises:
 * "no code runs until the contributed surface is used"). SVG strings are LRU-cached by
 * source+theme (failures are never cached); a failed render rejects with mermaid's message —
 * the host owns the error surface — after removing the orphan DOM node mermaid leaves behind.
 *
 * The cache is keyed on the exact source on purpose (a hash collision here would show the wrong
 * diagram), so it holds diagram text in the clear. The host clears it when a Protected
 * Document's key is discarded ({@link clearMermaidCache}); the renderer itself stays dumb
 * (ADR 0022) and only offers the clear.
 */

import type { AugmentationRenderer } from './contract'

let mermaidModule: Promise<typeof import('mermaid').default> | null = null
/** The theme mermaid's global config was last initialised with (it mutates module state). */
let initializedDark: boolean | null = null
let renderSeq = 0

const CACHE_MAX = 100
/** key `${dark}|${source}` → svg string; Map insertion order doubles as LRU recency. */
const svgCache = new Map<string, string>()
/**
 * Bumped by every clear. A render notes the generation before it awaits anything and only
 * caches its SVG if the generation is unchanged when it lands, so a render already in flight
 * when the cache was cleared cannot put its output back in afterwards.
 */
let generation = 0

/** Empty the SVG cache; a render in flight across this call will not repopulate it. */
export function clearMermaidCache(): void {
    svgCache.clear()
    generation++
}

/** How many SVGs the cache holds - for the dev introspection hook and the tests. */
export function mermaidCacheSize(): number {
    return svgCache.size
}

function cacheGet(key: string): string | undefined {
    const hit = svgCache.get(key)
    if (hit !== undefined) {
        svgCache.delete(key)
        svgCache.set(key, hit) // refresh recency
    }
    return hit
}

function cachePut(key: string, svg: string): void {
    svgCache.delete(key)
    svgCache.set(key, svg)
    if (svgCache.size > CACHE_MAX) svgCache.delete(svgCache.keys().next().value!)
}

function loadMermaid() {
    if (!mermaidModule) mermaidModule = import('mermaid').then((m) => m.default)
    return mermaidModule
}

function container(svg: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'gk-mermaid'
    el.innerHTML = svg
    return el
}

export const mermaidRenderer: AugmentationRenderer = {
    editing: 'preview',
    async render(source, { dark }) {
        const key = `${dark}|${source}`
        const cached = cacheGet(key)
        if (cached !== undefined) return container(cached)
        const startedIn = generation
        const mermaid = await loadMermaid()
        if (initializedDark !== dark) {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
            initializedDark = dark
        }
        const id = `gk-mermaid-${++renderSeq}`
        try {
            const { svg } = await mermaid.render(id, source)
            // The caller still gets its diagram; only the cache refuses a result from before a clear.
            if (startedIn === generation) cachePut(key, svg)
            return container(svg)
        } catch (error) {
            // Mermaid can leave an orphan error element in <body>; never let it accumulate.
            document.getElementById(id)?.remove()
            document.getElementById(`d${id}`)?.remove()
            throw error
        }
    },
}
