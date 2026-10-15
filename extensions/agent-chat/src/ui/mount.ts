/**
 * A Svelte component drawn into an element the Client gives, and taken back. The extension is
 * compiled with the Client's own Svelte (ADR 0121), so it uses its runtime.
 */
import { type Component, mount, unmount } from 'svelte'

export function mountComponent<Props extends Record<string, unknown>>(component: Component<Props>, target: HTMLElement, props: Props): { destroy(): void } {
    const instance = mount(component, { target, props })
    return {
        destroy() {
            void unmount(instance)
        },
    }
}
