/**
 * Opening a fence's widget over the whole EtherPK window (`FenceWindow.svelte`). One at a time:
 * opening another closes the one before, so Return always goes back to the document.
 */
import { mount, unmount } from 'svelte'

import type { DocumentStore } from '../types'
import type { InteractiveFence } from './augmentations/interactive-fence-contract'
import type { FenceRef } from './fence-hosting'
import FenceWindow from './FenceWindow.svelte'

let open: { close(): void } | null = null

export function openFenceWindow(options: { ref: FenceRef; fence: InteractiveFence; store: DocumentStore; openTab(): void }): void {
    open?.close()
    let closed = false
    const component = mount(FenceWindow, {
        target: document.body,
        props: {
            fenceRef: options.ref,
            fence: options.fence,
            store: options.store,
            onclose: () => handle.close(),
            onopentab: options.openTab,
        },
    })
    const handle = {
        close() {
            if (closed) return
            closed = true
            if (open === handle) open = null
            void unmount(component)
        },
    }
    open = handle
}

/** Close the open window, as the graph closes. */
export function closeFenceWindow(): void {
    open?.close()
}
