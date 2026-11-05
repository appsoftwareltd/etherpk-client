/**
 * Whether the app's header gives its height to what is in front on a phone. Hiding is a stylesheet
 * query in the two route layouts that read this, at the width where the presenters swap, so a window
 * that widens past it has its header back at once.
 *
 * A count, because each of a desktop's open PDF tabs holds this while it is mounted. The phone's
 * presenter mounts only the View in front, so there it says that View wants the room.
 */
import { untrack } from 'svelte'

let holders = $state(0)

export const appHeaderHiddenOnPhone = {
    get current() {
        return holders > 0
    },
}

/** Hide the header on a phone until the returned function is called. Made to be an `$effect`'s body. */
export function hideAppHeaderOnPhone(): () => void {
    // Untracked, or the effect that calls this would depend on the count it changes.
    holders = untrack(() => holders) + 1
    return () => {
        holders = untrack(() => holders) - 1
    }
}
