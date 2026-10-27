/**
 * The question a replace asks before it changes the name in a wikilink (ADR 0153 §4), as the find
 * box and the workspace both see it. The box plans and applies the replace against its own
 * editor. The workspace decides what to ask, asks, and runs the renames
 * (`workspace/replace-renames.ts`).
 */

/** What a replace mode changes: every match, or every match that touches no wikilink. */
export type ReplaceMode = 'all' | 'outside-links'

/** One replace the box asks about: planned and applied by the box, against its own editor. */
export interface ReplaceRequest {
    /** The document the replace is in. */
    target: string
    /** Plan the replace against the document as it is now. */
    plan(): { edits: readonly { before: string; after: string }[]; textAfter: string; replaced: number }
    /** Plan the replace afresh and apply it. Returns false when it changed nothing. */
    apply(mode: ReplaceMode): boolean
}

export type ReplaceOutcome = { kind: 'replaced'; renamed: boolean } | { kind: 'cancelled' } | { kind: 'refused' }
