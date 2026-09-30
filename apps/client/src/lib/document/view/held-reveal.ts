/**
 * A reveal a DocumentView holds: the line a [[Search]] result, a [[Kanban Board]] card or a [[Task
 * Reference]] asked it to show, kept for a short while after it is first placed.
 *
 * Held rather than placed and forgotten, because what asked for it is often followed by something
 * that would undo it:
 *
 * - Opening a result for an already-open document reveals first and then activates the View, and
 *   activation restores the remembered [[Reading Position]]. While held, the reveal outranks that
 *   restore (`restore`).
 * - The content may not have arrived yet: a [[Server Backend]] cache seed, a [[Filesystem Backend]]
 *   read. The line is placed again as it arrives (`contentChanged` with `arriving`, which the View
 *   says until the store's `whenReady` settles).
 *
 * It is placed again for nothing else. Once the content is in, an edit is not content arriving: it
 * may be another editor's on the same document (a Task Detail beside its tab, ADR 0113), and a line
 * number held across an edit above it names a different line. The hold lets go when its window
 * lapses, when the user acts in the editor, and when the editor is torn down (`release`).
 */

import type { RevealAlign } from './view-position'

/** How long a reveal outranks a restore: enough to span mounting, content arriving and the Layout activating the panel. */
export const REVEAL_HOLD_MS = 3000

/** What the held reveal asks of the editor it belongs to. */
export interface RevealEditor {
    /** Put the caret on a body line (0-based, as the index counts) and scroll it where `align` says. */
    reveal(line: number, align: RevealAlign): void
    /** Put the focus in the editor. */
    focus(): void
    /** Whether the focus is free to take: on nothing, on the page itself, or already in this editor. */
    focusIsFree(): boolean
}

export interface HeldReveal {
    /**
     * Place `line` now and hold it. `align` is where the line lands (centred unless asked otherwise);
     * `focus: false` leaves the focus where it is, for an editor shown beside the one in use.
     */
    hold(line: number, options?: { align?: RevealAlign; focus?: boolean }): void
    /**
     * The editor's text changed, other than by the user in this editor. `arriving` says whether the
     * content it opened to show was still on its way, so the change is that content.
     */
    contentChanged(change: { arriving: boolean }): void
    /** A Reading Position is about to be restored. True when a held reveal was placed instead. */
    restore(): boolean
    /** Let go of any held reveal. */
    release(): void
}

export function createHeldReveal(editor: RevealEditor): HeldReveal {
    let held: { line: number; align: RevealAlign; focus: boolean } | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined

    function place(focus: 'take' | 'if-free'): void {
        if (!held) return
        editor.reveal(held.line, held.align)
        // "Show me this" means the caret it placed should be usable. Content arriving is not the user
        // asking, and may land while they are typing elsewhere, so it takes a focus nobody holds.
        if (held.focus && (focus === 'take' || (focus === 'if-free' && editor.focusIsFree()))) editor.focus()
    }

    function release(): void {
        held = undefined
        if (expiry) clearTimeout(expiry)
        expiry = undefined
    }

    return {
        hold(line, { align = 'center', focus = true } = {}) {
            release()
            held = { line, align, focus }
            expiry = setTimeout(release, REVEAL_HOLD_MS)
            place('take')
        },
        contentChanged({ arriving }) {
            if (arriving) place('if-free')
        },
        restore() {
            if (!held) return false
            place('take')
            return true
        },
        release,
    }
}
