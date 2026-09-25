import { onMount } from 'svelte'

/**
 * Whether this component's JavaScript is live yet.
 *
 * Every auth form in these applications submits through a client library, with the handler
 * calling `preventDefault()`. Before hydration that handler does not exist, so a click on the
 * submit button performs a NATIVE form submission instead: the page reloads, whatever was typed
 * is discarded, and nothing is reported. The user reasonably believes they pressed the button.
 *
 * Gating the submit control on this closes that window - the button is simply not pressable until
 * pressing it would do what it says. It also makes browser-driven tests deterministic, because an
 * actionability check now waits for hydration rather than racing it.
 */
export function useHydrated(): { readonly ready: boolean } {
    let ready = $state(false)
    onMount(() => {
        ready = true
    })
    return {
        get ready() {
            return ready
        },
    }
}
