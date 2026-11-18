/**
 * The first-party asset viewers, registered together — the exact parallel of
 * `augmentations/renderers/register.ts`, which does the same for the built-in [[Augmentation]]
 * renderers (ADR 0022). Both ship as registrations rather than as core branches, so a type the
 * app can show is a fact about the registry rather than a condition in three files.
 *
 * Audio and video share one viewer and one player.
 *
 * PDF is loaded lazily by its own module; nothing here pulls pdf.js in. An EBook reads in a frame of its
 * own, whose page carries foliate-js, so nothing here pulls that in either.
 */

import { type ContributionRegistry, registerAssetViewer } from '#lib/surface/index.js'

import { AUDIO_EXTS, VIDEO_EXTS } from '#lib/storage/fs/asset-store.js'

import ImageAssetViewer from './ImageAssetViewer.svelte'
import MediaAssetViewer from './MediaAssetViewer.svelte'
import EbookAssetViewer from './ebook/EbookAssetViewer.svelte'
import PdfAssetViewer from './pdf/PdfAssetViewer.svelte'

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
        registerAssetViewer(registry, { extensions: ['epub'], component: EbookAssetViewer, label: 'EBook' }),
        // One player for both (media/media-player.ts), the same one a document draws under a media line.
        registerAssetViewer(registry, { extensions: [...VIDEO_EXTS], component: MediaAssetViewer, label: 'Video' }),
        registerAssetViewer(registry, { extensions: [...AUDIO_EXTS], component: MediaAssetViewer, label: 'Audio' }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
    }
}
