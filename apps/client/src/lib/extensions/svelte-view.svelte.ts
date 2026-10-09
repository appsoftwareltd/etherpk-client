/**
 * A Svelte component as an extension View (ADR 0121), for the extensions compiled into the
 * Client. They are compiled with the Client's own Svelte, so they share its runtime, and this
 * turns one of their components into the `mount(element, props)` every extension View follows.
 *
 * The props live in one reactive object the component is mounted with, so an `update` (a rename
 * re-keying the target) reaches the component as an ordinary prop change rather than a remount.
 * A loaded extension, built with a Svelte of its own, carries its own copy of this.
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
