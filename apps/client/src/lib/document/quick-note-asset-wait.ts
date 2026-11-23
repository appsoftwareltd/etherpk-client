/**
 * How long the Quick Notes View waits before asking again for a file a [[Quick Note]] names
 * and the graph's asset store does not have (ADR 0186).
 *
 * A note shared from another device reaches this one over the relay as soon as it is added,
 * while its file is still uploading from that device. So "not here" is often "not here yet":
 * the view asks again after a growing wait, and stops after about a quarter of an hour, when
 * the file is more likely deleted or still on a device that is offline.
 */

/** The first wait; each later one doubles, up to {@link QUICK_NOTE_ASSET_MAX_WAIT_MS}. */
export const QUICK_NOTE_ASSET_FIRST_WAIT_MS = 2_000
export const QUICK_NOTE_ASSET_MAX_WAIT_MS = 60_000
/** Asks after the first one. With the waits above they span about fifteen minutes. */
export const QUICK_NOTE_ASSET_RETRIES = 19

/** The wait before retry number `retry` (0 for the first), or null when no more follow. */
export function quickNoteAssetWait(retry: number): number | null {
    if (retry >= QUICK_NOTE_ASSET_RETRIES) return null
    return Math.min(QUICK_NOTE_ASSET_FIRST_WAIT_MS * 2 ** retry, QUICK_NOTE_ASSET_MAX_WAIT_MS)
}
