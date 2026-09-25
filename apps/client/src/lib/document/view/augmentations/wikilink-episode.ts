/**
 * When does an editing episode inside a [[Wikilink]] end, and what did it change? (ADR 0065)
 *
 * The text of a wikilink is its concept, so editing it in place proposes a [[Rename]] of the
 * concept the link named before - taken up when the user is *done* with the link, never per
 * keystroke: the caret leaves the link, the editor blurs, or the editor goes away. Pure, so
 * the nesting rules are unit-tested; the ViewPlugin in `wikilink.ts` feeds it.
 *
 * The subject is the **innermost balanced link that contained the first local change** of the
 * episode. Its range is carried through every later change, and at the end the link occupying
 * that range says what the concept became. An edit that leaves no balanced link there is a
 * structural edit and proposes nothing; a change of casing alone is not a change of concept.
 */

import { conceptKey } from '../../../storage/fs/identity'

/** A balanced wikilink at absolute offsets: `from` at its first `[`, `to` just past its last `]`. */
export interface LinkAt {
    concept: string
    from: number
    to: number
}

export interface WikilinkEpisodeUpdate {
    /** This user's own changes in this update, as `[from, to)` ranges of the OLD document. */
    localChanges: readonly { from: number; to: number }[]
    /** The link in the OLD document that an edit over `[from, to]` is an edit OF ({@link innermostLinkContainingEdit}), or null. */
    linkBefore: (from: number, to: number) => LinkAt | null
    /** The innermost balanced link in the NEW document containing `[from, to]`, or null. */
    linkAfter: (from: number, to: number) => LinkAt | null
    /** Map an old-document offset through this update's changes. */
    mapPos: (pos: number, assoc: -1 | 1) => number
    caret: number
    focused: boolean
}

/**
 * The innermost link an edit over `[from, to]` is an edit OF, or null. A link's editable text is
 * what lies between its brackets; the brackets are the edge of whatever encloses it. So a pure
 * insertion (`from === to`) counts as inside a link only strictly between its `[[` and `]]`,
 * which is what makes a space typed at the seam where an inner link's `]]` meets the outer
 * link's `]]` an edit of the outer link, not of the inner one (live, 2026-09-18: it proposed
 * renaming the inner concept to the outer link's whole text). A deletion or replacement that
 * takes in a bracket still belongs to that bracket's link: its text is what changes shape.
 */
export function innermostLinkContainingEdit(links: readonly LinkAt[], from: number, to: number): LinkAt | null {
    let best: LinkAt | null = null
    for (const link of links) {
        const inside = from === to ? from > link.from + 1 && from < link.to - 1 : link.from <= from && to <= link.to
        if (!inside) continue
        if (!best || link.to - link.from < best.to - best.from) best = link
    }
    return best
}

/** What an episode found when it ended: the concept before, and after (null: no link there). */
export interface WikilinkEdit {
    before: string
    after: string | null
}

export class WikilinkEpisode {
    #tracked: LinkAt | null = null

    /** Whether a link has been touched and the episode has not yet ended. */
    get open(): boolean {
        return this.#tracked !== null
    }

    /** Feed one editor update. Returns the edit when the episode ended, else null. */
    update(input: WikilinkEpisodeUpdate): WikilinkEdit | null {
        if (!this.#tracked && input.localChanges.length > 0) {
            const first = input.localChanges[0]
            const link = input.linkBefore(first.from, first.to)
            if (link) this.#tracked = { ...link }
        }
        const tracked = this.#tracked
        if (!tracked) return null
        // Carry the range through this update's changes - the first change included.
        tracked.from = input.mapPos(tracked.from, -1)
        tracked.to = input.mapPos(tracked.to, 1)

        const inside = input.caret > tracked.from && input.caret < tracked.to
        if (inside && input.focused) return null
        this.#tracked = null
        return finish(tracked, input.linkAfter)
    }

    /** The editor is going away: whatever was touched is done with. */
    close(linkAfter: (from: number, to: number) => LinkAt | null): WikilinkEdit | null {
        const tracked = this.#tracked
        this.#tracked = null
        return tracked ? finish(tracked, linkAfter) : null
    }
}

/** The edit an ended episode reports, or null when the concept did not change. */
function finish(tracked: LinkAt, linkAfter: (from: number, to: number) => LinkAt | null): WikilinkEdit | null {
    const after = linkAfter(tracked.from, tracked.to)
    if (after && conceptKey(after.concept) === conceptKey(tracked.concept)) return null
    return { before: tracked.concept, after: after?.concept ?? null }
}
