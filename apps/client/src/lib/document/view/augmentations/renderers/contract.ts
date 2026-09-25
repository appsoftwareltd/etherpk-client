/**
 * The Augmentation renderer contract (ADR 0022). A renderer turns fence/inline SOURCE into
 * DOM and knows nothing of the editor: widget lifecycle, reveal, clamping, and preview
 * attachment live in the core hosts (fence-render.ts, math-inline.ts). Registered under the
 * `augmentation-renderer` contribution kind (ADR 0017); the fence dispatch falls through to
 * live syntax highlighting (ADR 0018's default arm) when no renderer is registered. Phase-1
 * dogfooding: built-in code fills the same Contribution Point a future first-party
 * Extension will own (Extension Architecture.md).
 */

import { type ContributionRegistry, tryGetActiveContributionRegistry } from '$lib/surface'

export const AUGMENTATION_RENDERER_KIND = 'augmentation-renderer'

export interface RenderOpts {
    /** Resolved app theme at render time. */
    dark: boolean
    /** Inline (within-text) context — inline `$…$` math; fence hosts pass false. */
    inline?: boolean
}

export interface AugmentationRenderer {
    /**
     * Editing model (ADR 0022): `'preview'` — while revealed, the source is the editing
     * surface with a live-rendered preview attached below (mermaid); `'flip'` — rendered
     * when the caret is outside, raw source when inside (math).
     */
    editing: 'preview' | 'flip'
    /** Turn source into DOM. Must never reach for editor or outliner state. */
    render(source: string, opts: RenderOpts): Promise<HTMLElement>
}

export function registerAugmentationRenderer(
    registry: ContributionRegistry,
    id: string,
    renderer: AugmentationRenderer,
): () => void {
    return registry.register(AUGMENTATION_RENDERER_KIND, id, renderer)
}

/** The renderer for a fence info-string (exact match), or undefined — including when no registry is active. */
export function lookupAugmentationRenderer(info: string): AugmentationRenderer | undefined {
    const registry = tryGetActiveContributionRegistry()
    if (!registry || !info) return undefined
    return (registry.get(AUGMENTATION_RENDERER_KIND, info) as AugmentationRenderer | undefined) ?? undefined
}
