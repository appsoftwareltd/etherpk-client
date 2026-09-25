/**
 * Telling the user, once, that this session cannot cache the [[Derived Index]] (ADR 0041 §4).
 *
 * Since ADR 0042 a second tab ATTACHES to the owning tab's index rather than degrading, so
 * this notice is reserved for a browser that genuinely cannot persist: no usable OPFS
 * (private windows, older Safari), or none of the sharing primitives. Nothing is broken and
 * the only consequence is a slower open, so this is said once per device rather than on
 * every open, and thereafter lives in settings for anyone who goes looking.
 */

const KEY = 'etherpk.index-not-persisted-acknowledged'

/** True when this device has already been told (and dismissed it). */
export function indexNoticeAcknowledged(): boolean {
    try {
        return localStorage.getItem(KEY) === '1'
    } catch {
        // Storage denied (private mode) — better to say nothing than to nag every open.
        return true
    }
}

export function acknowledgeIndexNotice(): void {
    try {
        localStorage.setItem(KEY, '1')
    } catch {
        // Nothing to do: the notice simply cannot be remembered here.
    }
}

/** What the user is told. One sentence of fact, one of consequence, no alarm. */
export const INDEX_NOT_PERSISTED_MESSAGE =
    "This browser can't store this graph's search index between visits, so large graphs will take longer to open. Everything works normally otherwise, and your notes are unaffected."

/**
 * The ACTIONABLE variant: the pool is held by another live context, almost always a
 * forgotten window or tab still open on this graph. Recovery is automatic the moment the
 * holder closes (the tab reclaims the stored index by itself), so tell the user the one
 * thing they can do.
 */
export const INDEX_POOL_HELD_MESSAGE =
    "Another window or tab is holding this graph's stored search index, so this one is using a temporary copy. Close other EtherPK windows for this graph and it will reconnect to the stored index by itself. Your notes are unaffected."
