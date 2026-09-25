/**
 * Module accessor for the open graph's protection status, in the same shape as
 * {@link ../active-graph-settings} and the renderer registry lookup.
 *
 * The protected-fence augmentation needs to know whose key a fence wants and whether we hold it,
 * but it is constructed by the layout adapter with no Svelte context and no props. A CodeMirror
 * facet was the alternative and is worse: the value would have to be threaded through
 * `DocumentView` into `editorExtensions`, which would make every editor surface carry a service
 * it does not otherwise use. The one facet that does exist (`isProtectedDocumentFacet`, provided
 * by the fence augmentation) carries the per-document half - whether this editor's document is
 * protected - which `DocumentView` already threads; the key is per graph and stays here.
 *
 * Null when no graph is open, or before its record has loaded. Every consumer must treat null as
 * **locked** rather than as "not protected" - a fence whose status is unknown must never look
 * readable.
 */
import type { FenceUnreadableReason } from './protection-service'

export interface ProtectionStatus {
    /**
     * Classify the fence at character offset `from` within `docText`.
     *
     * The text is passed in rather than read from the active editor, because decorations are built
     * per editor state and more than one document pane can be open. Reading the *active* view here
     * classified an inactive pane's fence against a different document's offsets, so an
     * unlocked document in it rendered as locked.
     */
    reasonAt(docText: string, from: number): FenceUnreadableReason
    /**
     * Whether plaintext may be on screen right now - the session's `isReadable`, status exactly
     * `unlocked`. What the editing Commands and the asset upload ask before touching a Protected
     * Document's body; masked counts as not writable, since the fence is back in the text.
     */
    isReadable(): boolean
    /** Open the unlock prompt. */
    requestUnlock(): void
    /** Discard the key now. Graph-wide: the key is the unit (ADR 0058), not the document. */
    lockNow(): void
}

let active: ProtectionStatus | null = null

/**
 * Bumped whenever anything an editor renders from protection changes — the lock state, or a
 * decryption landing.
 *
 * A counter rather than a notification because there is no registry of open editors to notify: the
 * lock effect can only be dispatched into the *active* view, which would leave a second document
 * pane showing a stale locked card after unlocking. Each editor compares this against what it last
 * drew and refreshes itself, so every pane converges without anyone tracking them.
 */
let generation = 0

export function setActiveProtectionStatus(status: ProtectionStatus | null): void {
    active = status
    generation++
}

export function getActiveProtectionStatus(): ProtectionStatus | null {
    return active
}

export function protectionGeneration(): number {
    return generation
}

/** Note that what the editors should draw has changed. */
export function bumpProtectionGeneration(): void {
    generation++
}
