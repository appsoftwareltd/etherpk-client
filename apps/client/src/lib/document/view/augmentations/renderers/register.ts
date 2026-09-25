/**
 * Registers the built-in Augmentation renderers (ADR 0022). Called by the composition roots
 * beside registerEditorCommands. Phase-1 dogfooding (Extension Architecture.md): built-in
 * code filling the same Contribution Point a future first-party Extension will own — these
 * registrations move into it without changing shape. `math` is canonical and sole (no
 * `latex`/`tex` aliases — ADR 0022 Consequences).
 *
 * This is also where the render caches are cleared from: the host caches in rendered-common.ts
 * and mermaid's SVG cache, which between them hold rendered plaintext. The detach clears them
 * on graph close, and the composition root calls {@link clearAugmentationRenderCaches} itself
 * when a Protected Document's key is discarded (ADR 0058: nothing readable stays on the device).
 * The renderer contract stays dumb; the clearing is the host's business.
 */

import type { ContributionRegistry } from '$lib/surface'

import { clearRenderCaches, renderCacheSizes } from '../rendered-common'
import { registerAugmentationRenderer } from './contract'
import { katexRenderer } from './katex-renderer'
import { clearMermaidCache, mermaidCacheSize, mermaidRenderer } from './mermaid-renderer'

/**
 * Empty every render cache: the fence results' rendered nodes (and their pending renders), the
 * size and failure memories, and mermaid's SVG cache. Call it AFTER the locked documents have been
 * relocked (`relockAll().finally(...)`, not before the promise settles) - the live coordinators
 * render again whatever their editors still show, so a plaintext fence still on screen at this
 * moment would go straight back into the caches.
 */
export function clearAugmentationRenderCaches(): void {
    clearRenderCaches()
    clearMermaidCache()
}

/**
 * Dev/e2e-only introspection, the `__etherpkLayout` idiom: the render-cache spec asserts that
 * a lock leaves nothing behind, and a cache's size is not observable from the DOM.
 */
function installDevHook(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return
    ;(window as unknown as { __etherpkRenderCaches?: unknown }).__etherpkRenderCaches = {
        sizes: () => ({ ...renderCacheSizes(), mermaid: mermaidCacheSize() }),
        clear: () => clearAugmentationRenderCaches(),
    }
}

export function registerAugmentationRenderers(registry: ContributionRegistry): () => void {
    const detach = [
        registerAugmentationRenderer(registry, 'mermaid', mermaidRenderer),
        registerAugmentationRenderer(registry, 'math', katexRenderer),
    ]
    installDevHook()
    return () => {
        detach.forEach((d) => d())
        // Unregistered first, so the coordinators asked to re-render find no renderer and
        // schedule nothing: the graph is closing.
        clearAugmentationRenderCaches()
    }
}
