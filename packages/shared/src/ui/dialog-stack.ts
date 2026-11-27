/**
 * The dialogs open now, in the order they opened, for the shared Dialog (`../components/Dialog.svelte`).
 *
 * A dialog can open over another: the asset upload dialog over the Task Editor, a confirmation over
 * Settings. The one opened last is on top, and two things follow from that:
 *
 * - **Escape belongs to it.** Every dialog listens for Escape on the window, so without the stack
 *   one press closed both.
 * - **It is drawn over the dialog it was opened from**, backdrop and panel both. Every dialog used to
 *   take the same two layers, so which one painted on top was down to document order: the Task
 *   Editor, mounted after the app shell, covered the upload dialog the shell hosts, which then sat
 *   behind it out of reach of the pointer. Each dialog now takes its layers by its depth here, so
 *   the order is the order of opening, wherever each one is mounted.
 * - **The browser's Back closes it**, where an app listens ({@link DialogStack.subscribe}). A
 *   dialog says how it is dismissed when it opens. Other overlays that cover the page for a moment
 *   (the Client's Search, its full windows, a phone's drawers) take a place here for the same
 *   reason, though they draw their own layers: Back closes whatever is on top. One that is a place
 *   in the history with an entry of its own (the Client's Settings) gives no way to dismiss it, so
 *   Back is left to its entry.
 */

/** One open dialog's place in the stack. */
export interface OpenDialog {
    /** 0 for a dialog over the page, one more for each dialog it opened over. */
    readonly depth: number
    /** Whether it is the dialog on top, which takes Escape. */
    isTop(): boolean
    /** Take it off the stack. Harmless when it is already off. */
    close(): void
    /**
     * Dismiss it as Escape would, for the browser's Back. A dialog that cannot be dismissed now
     * (busy, or one that must be answered) does nothing. Absent on a dialog Back does not close.
     */
    readonly dismiss?: () => void
}

/** How a dialog is dismissed, given as it opens. */
export interface DialogOptions {
    /** What Back does to it, as {@link OpenDialog.dismiss}. Left out, Back does not close it. */
    dismiss?: () => void
}

/** A stack of open dialogs and other overlays. */
export interface DialogStack {
    /** Put a dialog on top. */
    open(options?: DialogOptions): OpenDialog
    /** The dialog on top, or null when none is open. */
    top(): OpenDialog | null
    /** Call `listener` whenever a dialog opens or closes. Returns the way to stop. */
    subscribe(listener: () => void): () => void
}

/** A stack of open dialogs. The Dialog shell shares one across every app ({@link dialogStack}). */
export function createDialogStack(): DialogStack {
    const open: OpenDialog[] = []
    const listeners = new Set<() => void>()
    const changed = () => {
        for (const listener of [...listeners]) listener()
    }
    return {
        open(options = {}) {
            // One above the dialog on top, not the count of dialogs open: when a dialog under
            // another closes first, the count falls, and a dialog opened then would tie with the
            // one still open, or fall under it.
            const depth = open.length === 0 ? 0 : open[open.length - 1].depth + 1
            const entry: OpenDialog = {
                depth,
                dismiss: options.dismiss,
                isTop: () => open[open.length - 1] === entry,
                close() {
                    const at = open.indexOf(entry)
                    if (at < 0) return
                    open.splice(at, 1)
                    changed()
                },
            }
            open.push(entry)
            changed()
            return entry
        },
        top: () => open[open.length - 1] ?? null,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

/** The stack every Dialog shares. */
export const dialogStack = createDialogStack()

/**
 * How many levels a dialog may step up over the page before it stops stepping. `layers.css` keeps
 * the Context Menu and Search above the deepest level, so a menu opened inside a nested dialog is
 * still drawn over it; deeper dialogs share the deepest level and fall back on document order.
 */
export const MAX_DIALOG_DEPTH = 3

/**
 * The `z-index` of a dialog's backdrop or panel at `depth`: the sheet's `--z-backdrop` and
 * `--z-dialog` layers, raised by `--z-dialog-step` for each dialog it opened over. A step is wide
 * enough that a nested dialog's backdrop sits over the panel below it, so the dialog underneath is
 * dimmed and out of the pointer's reach, as the page is under the first.
 */
export function dialogLayer(layer: 'backdrop' | 'panel', depth: number): string {
    const base = layer === 'backdrop' ? 'var(--z-backdrop)' : 'var(--z-dialog)'
    const steps = Math.min(Math.max(0, depth), MAX_DIALOG_DEPTH)
    return steps === 0 ? base : `calc(${base} + ${steps} * var(--z-dialog-step))`
}
