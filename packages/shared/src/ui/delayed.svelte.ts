/**
 * A progress flag that cannot flash (AGENTS.md rule 2).
 *
 * An indicator that appears and vanishes inside ~100ms reads as a glitch rather than as
 * progress, so `current` only becomes true once `active` has stayed true for `delayMs`.
 * The pattern was already proven in the client's document loader; this is that timer,
 * extracted so every other surface does not have to reinvent it.
 */
export function delayedFlag(active: () => boolean, delayMs = 150): { readonly current: boolean } {
    let shown = $state(false)

    $effect(() => {
        if (!active()) {
            shown = false
            return
        }
        const timer = setTimeout(() => (shown = true), delayMs)
        return () => clearTimeout(timer)
    })

    return {
        get current() {
            return shown
        },
    }
}
