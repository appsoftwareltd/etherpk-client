/**
 * When the toolbar's indexing icon shows, given when the search index is busy.
 *
 * The index is busy for a few milliseconds after every keystroke's ingest, and for seconds when a
 * rename replaces the whole index. Only the second is worth an icon: a person who renamed a page
 * and finds Quick Find or a link not yet following can see that the change is still being taken
 * in. So the icon shows once the index has been busy for `showAfterMs` without a break, and goes
 * once it has been idle for `hideAfterMs`, which keeps it steady between runs that follow one
 * another instead of blinking off and on.
 *
 * Pure apart from its timers, so the rule is unit-tested without a workspace.
 */

export interface IndexingIndicatorOptions {
    /** How long the index must be busy before the icon shows. 0 shows it at once. */
    showAfterMs?: number
    /** How long the index must be idle before the icon goes. */
    hideAfterMs?: number
}

export interface IndexingIndicator {
    /** Report whether the index is busy now; repeating the same answer changes nothing. */
    busy(value: boolean): void
    dispose(): void
}

export const INDEXING_ICON_SHOW_AFTER_MS = 500
export const INDEXING_ICON_HIDE_AFTER_MS = 300

export function createIndexingIndicator(
    onShownChange: (shown: boolean) => void,
    { showAfterMs = INDEXING_ICON_SHOW_AFTER_MS, hideAfterMs = INDEXING_ICON_HIDE_AFTER_MS }: IndexingIndicatorOptions = {},
): IndexingIndicator {
    let shown = false
    let disposed = false
    let showTimer: ReturnType<typeof setTimeout> | undefined
    let hideTimer: ReturnType<typeof setTimeout> | undefined

    function setShown(next: boolean): void {
        if (disposed || next === shown) return
        shown = next
        onShownChange(next)
    }

    function clearTimers(): void {
        if (showTimer !== undefined) clearTimeout(showTimer)
        if (hideTimer !== undefined) clearTimeout(hideTimer)
        showTimer = undefined
        hideTimer = undefined
    }

    return {
        busy(value) {
            if (disposed) return
            if (value) {
                // Busy again within the hide delay: the icon stays, as if the runs were one.
                if (hideTimer !== undefined) {
                    clearTimeout(hideTimer)
                    hideTimer = undefined
                }
                // The wait is measured from the start of the spell, so a repeat does not restart it.
                if (shown || showTimer !== undefined) return
                if (showAfterMs <= 0) {
                    setShown(true)
                    return
                }
                showTimer = setTimeout(() => {
                    showTimer = undefined
                    setShown(true)
                }, showAfterMs)
                return
            }
            if (showTimer !== undefined) {
                clearTimeout(showTimer)
                showTimer = undefined
            }
            if (!shown || hideTimer !== undefined) return
            hideTimer = setTimeout(() => {
                hideTimer = undefined
                setShown(false)
            }, hideAfterMs)
        },
        dispose() {
            disposed = true
            clearTimers()
        },
    }
}
