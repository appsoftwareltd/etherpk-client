/**
 * The first-party asset viewers, registered together — the exact parallel of
 * `augmentations/renderers/register.ts`, which does the same for the built-in [[Augmentation]]
 * renderers (ADR 0022). Both ship as registrations rather than as core branches, so a type the
 * app can show is a fact about the registry rather than a condition in three files.
 *
 * PDF is loaded lazily by its own module; nothing here pulls pdf.js in.
 */

import { type ContributionRegistry, registerAssetViewer } from '$lib/surface'

import ImageAssetViewer from './ImageAssetViewer.svelte'
import PdfAssetViewer from './PdfAssetViewer.svelte'

/** Register every built-in viewer. Returns a disposer for the lot. */
export function registerAssetViewers(registry: ContributionRegistry): () => void {
    const disposers = [
        // The same extensions the Asset store renders inline (`isImageExt`), so anything shown
        // in a document can also be opened full size.
        registerAssetViewer(registry, {
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'],
            component: ImageAssetViewer,
            label: 'Image',
        }),
        registerAssetViewer(registry, { extensions: ['pdf'], component: PdfAssetViewer, label: 'PDF' }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
