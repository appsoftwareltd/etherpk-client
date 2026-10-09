/**
 * A Svelte component as an extension View: the `mount(element, props)` every extension View
 * follows (ADR 0121). This bundle carries its own Svelte, compiled with it, so it carries its own
 * copy of this too rather than borrowing the Client's.
 *
 * The props live in one reactive object the component is mounted with, so an `update` (a move to
 * another Pane) reaches the component as an ordinary prop change rather than a remount.
 */
import type { MountedView, ViewContribution, ViewMountProps } from '@appsoftwareltd/etherpk-extension-api'
import { type Component, mount, unmount } from 'svelte'

export function svelteView(component: Component<ViewMountProps>): ViewContribution {
    return {
        mount(element: HTMLElement, initial: ViewMountProps): MountedView {
            const props = $state({ ...initial })
            const instance = mount(component, { target: element, props })
            return {
                update(next) {
                    Object.assign(props, next)
                },
                destroy() {
                    void unmount(instance)
                },
            }
        },
    }
}
