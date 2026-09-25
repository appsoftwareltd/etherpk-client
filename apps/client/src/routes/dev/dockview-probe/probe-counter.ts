/**
 * Module-level mount/dispose counter for the dockview validation probe.
 *
 * A Svelte component bumps `mounts` on mount and `disposes` on destroy, so the
 * Playwright probe can prove that mounting/disposing real Svelte 5 components
 * into dockview panel containers works and is balanced.
 */
export const probeCounter = { mounts: 0, disposes: 0 }
