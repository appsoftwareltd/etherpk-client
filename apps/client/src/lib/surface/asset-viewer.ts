/**
 * The **asset-viewer [[Contribution Point]]**: which component shows an [[Asset]] of a given
 * type in its own tab. The registry's fifth kind, alongside View, command-menu, command-bar and
 * context-menu (ADR 0017 generalised it early for exactly this).
 *
 * "A supported file type" therefore means one thing and is asked in one place: **a viewer is
 * registered for its extension**. The open-in-a-tab affordance appears if and only if one is,
 * so adding video or CSV support is a registration rather than an edit to the editor, the
 * context menu and the asset View — which is how ADR 0022's rendered augmentations already work.
 *
 * Image and PDF viewers ship first-party. Nothing here renders anything itself; see ADR 0055 for
 * why a PDF is drawn by the app rather than framed.
 */

import type { Component } from 'svelte'

import type { ContributionRegistry } from './contribution-registry'

/** The point kind asset viewers are registered under. */
export const ASSET_VIEWER_KIND = 'asset-viewer'

/** What the asset View hands the mounted viewer. */
export interface AssetViewerProps {
    /** Object URL for the decrypted bytes. */
    url: string
    /** The asset's own file name, hash-free. */
    name: string
    /** MIME type, or `''` when unknown. */
    type: string
}

export interface AssetViewer {
    /** Lower-case extensions, no leading dot. One registration covers them all. */
    extensions: string[]
    /** What the tab mounts. */
    component: Component<AssetViewerProps>
    /** Short human name for the type ("PDF", "Image") — the open affordance's tooltip. */
    label: string
}

/** Register a viewer for each of its extensions. Returns one disposer for the lot. */
export function registerAssetViewer(registry: ContributionRegistry, viewer: AssetViewer): () => void {
    const disposers = viewer.extensions.map((ext) =>
        registry.register(ASSET_VIEWER_KIND, ext.replace(/^\./, '').toLowerCase(), viewer),
    )
    return () => {
        for (const dispose of disposers) dispose()
    }
}

/** The extension of a file name or an [[Asset Reference]], lower-cased, or `''`. */
export function assetExtension(nameOrRef: string): string {
    const file = (nameOrRef.split(/[?#]/)[0].split('/').pop() ?? '').trim()
    const dot = file.lastIndexOf('.')
    return dot <= 0 ? '' : file.slice(dot + 1).toLowerCase()
}

/** The viewer that can show this file, or `undefined` when nothing can. */
export function assetViewerFor(registry: ContributionRegistry, nameOrRef: string): AssetViewer | undefined {
    const ext = assetExtension(nameOrRef)
    if (!ext) return undefined
    return registry.get(ASSET_VIEWER_KIND, ext) as AssetViewer | undefined
}

/** Whether anything registered can show this file — what gates the open-in-a-tab affordance. */
export function canViewAsset(registry: ContributionRegistry, nameOrRef: string): boolean {
    return assetViewerFor(registry, nameOrRef) !== undefined
}
