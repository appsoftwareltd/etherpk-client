/** Where the window was, kept between runs and only used while it is still on a screen. */
export interface Bounds { x: number; y: number; width: number; height: number }
export interface WindowState { bounds: Bounds | null; maximized: boolean; scheme: 'light' | 'dark' | null }

export const DEFAULT_SIZE = { width: 1280, height: 860 }
export const SMALLEST_SIZE = { width: 360, height: 400 }
/** So much of the window has to be on a screen for a person to take hold of it. */
const ENOUGH = 100

function isBounds(value: unknown): value is Bounds {
    const bounds = value as Partial<Bounds> | null
    return typeof bounds === 'object' && bounds !== null && [bounds.x, bounds.y, bounds.width, bounds.height].every((one) => Number.isSafeInteger(one))
}

export function parseWindowState(text: string | null): WindowState {
    let kept: Partial<WindowState> | null = null
    try {
        kept = JSON.parse(text ?? 'null') as Partial<WindowState> | null
    } catch {
        // A window in its usual place is all that is lost.
    }
    return {
        bounds: isBounds(kept?.bounds) ? kept.bounds : null,
        maximized: kept?.maximized === true,
        scheme: kept?.scheme === 'dark' || kept?.scheme === 'light' ? kept.scheme : null,
    }
}

function overlap(a: Bounds, b: Bounds): { width: number; height: number } {
    return {
        width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
        height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
    }
}

/** The kept place when enough of it is on a screen that is there now, else the usual size and no place. */
export function usableBounds(state: WindowState, workAreas: readonly Bounds[]): Partial<Bounds> & { width: number; height: number } {
    const { bounds } = state
    if (!bounds || bounds.width < SMALLEST_SIZE.width || bounds.height < SMALLEST_SIZE.height) return DEFAULT_SIZE
    const seen = workAreas.some((area) => {
        const { width, height } = overlap(bounds, area)
        // The top edge carries the title bar.
        return width >= ENOUGH && height >= ENOUGH && bounds.y >= area.y - 10
    })
    return seen ? bounds : DEFAULT_SIZE
}

/** Further than this from what was asked for, the window manager or the person placed the window. */
const FRAME_AT_MOST = 24

/**
 * What to ask for next time so that a window comes back where it is. On some Linux desktops a window
 * reports bounds a few pixels outside those it was given, and asking for what was reported would make
 * it grow at each start.
 */
export function boundsToKeep(asked: Bounds | null, given: Bounds | null, now: Bounds): Bounds {
    if (!asked || !given) return now
    const sides = ['x', 'y', 'width', 'height'] as const
    if (sides.some((side) => Math.abs(given[side] - asked[side]) > FRAME_AT_MOST)) return now
    return { x: now.x - given.x + asked.x, y: now.y - given.y + asked.y, width: now.width - given.width + asked.width, height: now.height - given.height + asked.height }
}
