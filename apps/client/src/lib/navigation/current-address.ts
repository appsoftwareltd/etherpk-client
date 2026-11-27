/**
 * The address the window is at, for a surface that shows it (`PageAddressField.svelte`).
 *
 * SvelteKit's `page.url` follows real navigations only. The workspace writes most of its addresses
 * shallowly (a Visit, Settings opening, a Block View's link settling), and those never reach
 * `page.url`, so the address is read from `location`, and read again after every queued history
 * write (`history-writes.ts`) and on Back and Forward. A caller that shows it reads `page.url` as
 * well, for the real navigations.
 */
import { createSubscriber } from 'svelte/reactivity'

import { afterEachHistoryWrite } from './history-writes'

const changes = createSubscriber((update) => {
    const stopWrites = afterEachHistoryWrite(update)
    window.addEventListener('popstate', update)
    window.addEventListener('hashchange', update)
    return () => {
        stopWrites()
        window.removeEventListener('popstate', update)
        window.removeEventListener('hashchange', update)
    }
})

/** The window's address as a path, with its query and fragment. Reactive in a component or an effect. */
export function currentAddressPath(): string {
    changes()
    return `${location.pathname}${location.search}${location.hash}`
}
