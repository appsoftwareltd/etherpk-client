/**
 * Shared mount/dispose tally for {@link DevView}, the dev harness's fake View.
 *
 * The mount counter is the cheapest test oracle for the singleton rule: opening
 * a View twice (reveal) must not create a second mount, while `forceNew` must.
 * `mounts` is the running total of DevViews ever created; `live` is how many are
 * currently mounted (proves per-View teardown on close).
 */
export const devViewStats = $state({ mounts: 0, live: 0 })

/** Record a DevView mount; returns its 1-based mount ordinal for display. */
export function registerDevViewMount(): number {
    devViewStats.mounts += 1
    devViewStats.live += 1
    return devViewStats.mounts
}

export function registerDevViewDispose(): void {
    devViewStats.live -= 1
}

/** Reset the tally (used by the harness's reset action). */
export function resetDevViewStats(): void {
    devViewStats.mounts = 0
    devViewStats.live = 0
}
