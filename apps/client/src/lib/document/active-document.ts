/**
 * The concept of the document the user is currently working in. DocumentView
 * announces it when its editor mounts or gains focus; the Backlinks View follows
 * it so it always shows references to the page you are looking at (Logseq-style).
 *
 * This rides the extension surface's Event bus: setting the active document emits
 * `document:active-changed`, and consumers subscribe to that event rather than to
 * a bespoke store. The bus has no replay, so a consumer mounting *after* the
 * current document was announced reads {@link getActiveDocument} once for the
 * present value, then subscribes for changes.
 *
 * Emitting tolerates no active bus (the `/dev/editor` harness mounts a
 * DocumentView with no graph): it simply records the value and skips the emit.
 */

import { tryGetActiveEventBus } from '$lib/surface'

let current: string | null = null

export function setActiveDocument(documentId: string | null): void {
    current = documentId
    tryGetActiveEventBus()?.emit('document:active-changed', { documentId })
}

/** The active document's concept right now, or `null` when none is focused. */
export function getActiveDocument(): string | null {
    return current
}
