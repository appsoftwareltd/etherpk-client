/**
 * A flushable trailing debounce. Autosave coalesces rapid keystrokes into one
 * write (`call`), but the store must be able to force a pending write out
 * synchronously when it disposes or before a deliberate reload (`flush`), and to
 * drop a pending write when a conflict pauses autosave (`cancel`).
 */

export interface Debounced<Args extends unknown[]> {
    /** Schedule (or reschedule) a trailing invocation after the delay. */
    call(...args: Args): void
    /** Run the pending invocation now, if any. */
    flush(): void
    /** Drop the pending invocation, if any. */
    cancel(): void
}

export function debounce<Args extends unknown[]>(
    fn: (...args: Args) => void,
    ms: number,
): Debounced<Args> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: Args | undefined

    function clear() {
        if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
        }
        pending = undefined
    }

    return {
        call(...args: Args) {
            pending = args
            if (timer !== undefined) clearTimeout(timer)
            timer = setTimeout(() => {
                const args = pending!
                clear()
                fn(...args)
            }, ms)
        },
        flush() {
            if (pending === undefined) return
            const args = pending
            clear()
            fn(...args)
        },
        cancel() {
            clear()
        },
    }
}
