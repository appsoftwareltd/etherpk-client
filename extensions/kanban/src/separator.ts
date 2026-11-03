/**
 * A separator a person drags to resize what is beside it: the divider between a [[Kanban Board]]'s
 * lanes and its [[Task Detail]], and the handle under each of the [[Task Editor]]'s part editors.
 * One gesture and one key table for both, so they feel the same.
 *
 * The keys follow the window splitter pattern: ↑ and ↓ move the separator a step, Home takes it as
 * far up as it goes and End as far down. Whether that grows what it resizes depends on which side
 * of the separator that is (`growsDownward`).
 */

export interface SeparatorRange {
    min: number
    max: number
    /** How far one arrow press moves it. */
    step: number
    /** True when moving the separator down makes what it resizes larger: it sits below it. */
    growsDownward: boolean
}

/** The value a key moves the separator to, held inside the range, or null for a key it does not take. */
export function separatorKeyValue(key: string, value: number, range: SeparatorRange): number | null {
    const down = range.growsDownward ? 1 : -1
    const moved =
        key === 'ArrowDown'
            ? value + down * range.step
            : key === 'ArrowUp'
              ? value - down * range.step
              : key === 'Home'
                ? range.growsDownward
                    ? range.min
                    : range.max
                : key === 'End'
                  ? range.growsDownward
                      ? range.max
                      : range.min
                  : null
    return moved === null ? null : Math.min(range.max, Math.max(range.min, moved))
}

/**
 * Follow a press on a separator as a drag: the pointer is captured, so the drag keeps going when it
 * leaves the separator's few pixels, and `onMove` is told where it is until it is let go, when
 * `onEnd` runs (to keep what the drag chose). A press with any button but the main one is left alone.
 */
export function dragSeparator(event: PointerEvent, onMove: (move: PointerEvent) => void, onEnd?: () => void): void {
    if (event.button !== 0) return
    const handle = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    event.preventDefault()
    const move = (moved: PointerEvent) => {
        if (moved.pointerId === pointerId) onMove(moved)
    }
    const end = (ended: PointerEvent) => {
        if (ended.pointerId !== pointerId) return
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        onEnd?.()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
}
