/**
 * The widget Ink registers for ` ```ink.drawing ` fences: how tall a drawing is in the document,
 * and how its component is mounted and driven by the Client (`MountedFence`).
 */
import type { FenceContext, FenceWidget, MountedFence } from '@appsoftwareltd/etherpk-extension-api'
import { mount, unmount } from 'svelte'

import InkBlock from './InkBlock.svelte'
import type { InkServices } from './services'
import { inkHeight } from './sizes'

export function createInkWidget(services: InkServices): FenceWidget {
    return {
        height: (info) => inkHeight(info, services.columnWidth),
        mount(host: HTMLElement, context: FenceContext): MountedFence {
            // The context is replaced whole at each update; the services are shared, never proxied,
            // so the column width a widget measures is the one `height` reads.
            let current = $state.raw(context)
            const component = mount(InkBlock, {
                target: host,
                props: {
                    get context() {
                        return current
                    },
                    services,
                },
            })
            // Asked once, as the widget mounts: `/ink` put it in, or it opens in a tab or the window.
            if (context.takeFocus()) component.activate()
            return {
                update(next: FenceContext) {
                    current = next
                },
                flush() {
                    component.flush()
                },
                destroy() {
                    void unmount(component)
                },
            }
        },
    }
}
