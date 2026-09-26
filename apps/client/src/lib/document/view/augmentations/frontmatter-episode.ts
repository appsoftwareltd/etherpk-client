/**
 * When does an editing episode in the [[Frontmatter]] end? (ADR 0061)
 *
 * The block's identity keys are applied when the user is *done* with the block, not per
 * keystroke - a rename dialog opening at "Kanba" is the thing to avoid. Done means: the block was
 * touched by a local edit, and then the caret left it, or the editor lost focus, or the editor
 * went away. Pure, so the decision is unit-tested; the ViewPlugin in `frontmatter.ts` feeds it.
 */

export interface EpisodeUpdate {
    /** Last offset inside the block before and after the update, or -1 with no block. */
    blockEndBefore: number
    blockEndAfter: number
    /** Local (non-external) changes in this update, as `[from, to)` ranges of the old document. */
    changes: readonly { from: number; to: number }[]
    caret: number
    focused: boolean
}

/** What the View reports when an episode ends, for the proposal to weigh. */
export interface EpisodeEnd {
    /**
     * The block did not exist when the episode began: the person typed or pasted it in this
     * episode. Such a block claims nothing about aliases until it has an `aliases` key.
     */
    blockIsNew: boolean
}

export class FrontmatterEpisode {
    #touched = false
    #blockIsNew = false

    /** Whether the block has been touched and the episode has not yet ended. */
    get open(): boolean {
        return this.#touched
    }

    /**
     * Whether the block the current or last episode touched was absent when that episode began.
     * Read it when `update` or `close` reports the end.
     */
    get blockIsNew(): boolean {
        return this.#blockIsNew
    }

    /** Feed one editor update. Returns true when the episode ended and should be reported. */
    update(input: EpisodeUpdate): boolean {
        if (
            input.changes.some(
                (change) => change.from <= input.blockEndBefore || change.from <= input.blockEndAfter,
            )
        ) {
            // Judged once, at the first edit that touches the block, so later updates in the same
            // episode (where the block now exists) do not change the answer.
            if (!this.#touched) this.#blockIsNew = input.blockEndBefore < 0
            this.#touched = true
        }
        if (!this.#touched) return false
        const inside = input.blockEndAfter >= 0 && input.caret <= input.blockEndAfter
        if (inside && input.focused) return false
        this.#touched = false
        return true
    }

    /** The editor is going away: whatever was touched is done with. */
    close(): boolean {
        const fire = this.#touched
        this.#touched = false
        return fire
    }
}
