/**
 * When a [[Kanban Board]]'s status line goes away by itself. The line says what a move just did
 * ("Moved … to Doing", with Undo), and the board already shows the result, so it does not need to
 * stay until it is dismissed: it goes {@link STATUS_DISMISS_MS} after it appears. Mod+Z still
 * undoes the move once it has gone.
 *
 * It waits while the pointer is over it or the keyboard is in it, so Undo cannot vanish as it is
 * reached for, and starts the full wait again when both have left (WCAG 2.2.1: a time limit a person
 * can extend). A line about work still under way ("Moving the tasks…") stays until the work ends
 * and the line says what it did.
 *
 * Framework-free, so the timing is tested with fake timers; the View calls it from its handlers.
 */

/** How long the status line stays once nothing holds it. */
export const STATUS_DISMISS_MS = 5000

export type StatusHold = 'pointer' | 'focus'

export interface StatusDismiss {
    /** A line is shown, or replaced by a newer one: wait again from now, unless it is `busy`. */
    show(options?: { busy?: boolean }): void
    /** The line was dismissed or replaced by nothing: stop waiting. */
    hide(): void
    /** The pointer or the keyboard came onto the line (`true`) or left it. */
    hold(by: StatusHold, held: boolean): void
    dispose(): void
}

export function createStatusDismiss(dismiss: () => void, waitMs = STATUS_DISMISS_MS): StatusDismiss {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** A line is showing whose wait can run: shown, and not about work under way. */
    let waiting = false
    const holds = new Set<StatusHold>()

    function stop(): void {
        clearTimeout(timer)
        timer = undefined
    }

    function restart(): void {
        stop()
        if (!waiting || holds.size > 0) return
        timer = setTimeout(() => {
            timer = undefined
            waiting = false
            dismiss()
        }, waitMs)
    }

    return {
        show(options) {
            waiting = !options?.busy
            restart()
        },
        hide() {
            waiting = false
            stop()
        },
        hold(by, held) {
            if (held) holds.add(by)
            else holds.delete(by)
            restart()
        },
        dispose: stop,
    }
}
