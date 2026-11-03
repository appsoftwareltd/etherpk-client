/**
 * The [[Lightbox]]: one image, or a run of them, shown as large as the viewport allows in a dialog
 * over whatever is open, the Task Editor included. The document editor's image actions open it on
 * one image ("View larger", `asset.view-image`), and an extension opens it on a list of the graph's
 * images with `context.assets.viewImages` (the Kanban Task Editor's Assets list).
 *
 * It is drawn on the page's body, outside every View and dialog, so no form, disabled fieldset or
 * key handler of what opened it reaches inside it, and the shared dialog stack puts it above any
 * dialog already open. One at a time: opening another closes the first. The dialog's own focus
 * rule hands the keyboard back to whatever had it when the Lightbox opened.
 */
import { mount, unmount } from 'svelte'

import Lightbox from './Lightbox.svelte'
import type { LightboxImage } from './lightbox-image'

export type { LightboxImage } from './lightbox-image'

/** Closes the Lightbox open now, or null when none is. */
let closeOpen: (() => void) | null = null

/**
 * Show `images`, starting at the one at `start`. Resolves once the Lightbox closes: by Esc, its close
 * button or its backdrop, by another one opening, or by {@link closeLightbox}. Nothing opens for no
 * images.
 */
export function openLightbox(images: readonly LightboxImage[], start = 0): Promise<void> {
    closeOpen?.()
    if (images.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const close = () => {
            if (closeOpen !== close) return
            closeOpen = null
            void unmount(instance)
            host.remove()
            resolve()
        }
        const instance = mount(Lightbox, { target: host, props: { images: [...images], start, onclose: close } })
        closeOpen = close
    })
}

/** Close the Lightbox if one is open: the graph it shows images from is closing. */
export function closeLightbox(): void {
    closeOpen?.()
}
