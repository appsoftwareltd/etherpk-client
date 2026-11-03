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
 */

/** One open dialog's place in the stack. */
export interface OpenDialog {
    /** 0 for a dialog over the page, one more for each dialog it opened over. */
    readonly depth: number
    /** Whether it is the dialog on top, which takes Escape. */
    isTop(): boolean
    /** Take it off the stack. Harmless when it is already off. */
    close(): void
}

/** A stack of open dialogs. The Dialog shell shares one across every app ({@link dialogStack}). */
export function createDialogStack(): { open(): OpenDialog } {
    const open: OpenDialog[] = []
    return {
        open() {
            // One above the dialog on top, not the count of dialogs open: when a dialog under
            // another closes first, the count falls, and a dialog opened then would tie with the
            // one still open, or fall under it.
            const depth = open.length === 0 ? 0 : open[open.length - 1].depth + 1
            const entry: OpenDialog = {
                depth,
                isTop: () => open[open.length - 1] === entry,
                close() {
                    const at = open.indexOf(entry)
                    if (at >= 0) open.splice(at, 1)
                },
            }
            open.push(entry)
            return entry
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
