/**
 * `context.layout.openWindow` (ADR 0147): an extension's content over the whole EtherPK window
 * (`ExtensionWindow.svelte`). One at a time: opening another closes the one before, so Return
 * always goes back to where the person was. The window closes with the graph too.
 */
import { mount, unmount } from 'svelte'

import ExtensionWindow from './ExtensionWindow.svelte'

export interface ExtensionWindowOptions {
    title: string
    mount(host: HTMLElement, window: { close(): void }): { destroy(): void }
    onClose?(): void
}

let open: { close(): void } | null = null

export function openExtensionWindow(options: ExtensionWindowOptions): { close(): void } {
    open?.close()
    let closed = false
    const handle = {
        close() {
            if (closed) return
            closed = true
            if (open === handle) open = null
            void unmount(component)
            try {
                options.onClose?.()
            } catch (error) {
                console.error('[extension-window] closing failed', error)
            }
        },
    }
    const component = mount(ExtensionWindow, {
        target: document.body,
        props: { title: options.title, mount: options.mount, onclose: () => handle.close() },
    })
    open = handle
    return handle
}

/** Close the open window, as the graph closes. */
export function closeExtensionWindow(): void {
    open?.close()
}
