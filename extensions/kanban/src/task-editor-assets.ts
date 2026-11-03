/**
 * The graph's assets as the [[Task Editor]]'s Assets list reaches them (ADR 0170): each asset a task
 * shows, named as a person reads it, and the picture of an image, read through the extension's own
 * context (`context.assets`) as the document's editor reads the images it draws.
 *
 * A thumbnail opens the task's images larger in the Client's Lightbox (`context.assets.viewImages`).
 *
 * The Task Editor is drawn inside a View and by the "Open in task editor" Command, neither of which
 * is handed the context, so the context's assets are set here as the extension starts in a graph
 * (register.ts), as the concept rules are (`board-actions.ts`).
 */
import type { ExtensionAssets } from '@appsoftwareltd/etherpk-extension-api'

let graphAssets: ExtensionAssets | null = null

/** Set as the extension starts in a graph: each graph it starts in sets its own. */
export function setTaskEditorAssets(assets: ExtensionAssets | null): void {
    graphAssets = assets
}

/** One row of the Assets list. */
export interface AssetShown {
    /** The reference as the document writes it: the row's key. */
    ref: string
    /** The name a person reads, without the hash or id the graph adds. */
    name: string
    /** The whole file name, for the row's tooltip. */
    fileName: string
    image: boolean
}

/** The last part of a reference, decoded where it decodes. */
function lastPart(ref: string): string {
    const part = ref.split('/').at(-1) ?? ref
    try {
        return decodeURIComponent(part)
    } catch {
        return part
    }
}

/** How the Assets list shows `ref`: the graph's own name for it, or its file name when the graph has none to give. */
export function assetShown(ref: string): AssetShown {
    const described = graphAssets?.describe(ref)
    if (described) return { ref, ...described }
    const fileName = lastPart(ref)
    return { ref, name: fileName, fileName, image: false }
}

/** The address the image `ref` shows at, or null for no picture (the row shows a file icon). */
export async function taskAssetImage(ref: string): Promise<string | null> {
    return (await graphAssets?.imageUrl(ref)) ?? null
}

/**
 * Show the task's images in the Client's Lightbox, opened on `start`, with Previous and Next stepping
 * through the others in the Assets list's order. `refs` is the whole list: the Client leaves out
 * the files that are not images. Resolves once the Lightbox closes.
 */
export async function viewTaskImages(refs: readonly string[], start: string): Promise<void> {
    await graphAssets?.viewImages({ refs, start })
}
