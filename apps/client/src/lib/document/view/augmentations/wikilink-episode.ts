/**
 * When does an editing episode inside a [[Wikilink]] end, and what did it change? (ADR 0065,
 * amended 2026-10-03)
 *
 * The text of a wikilink is its concept, so editing it in place proposes a [[Rename]] of the
 * concept the link named before - taken up when the user is *done* with the link, never per
 * keystroke. The link is taken whole: the episode opens on the **outermost** link the first local
 * change is an edit of, with every link nested in it, and ends only when the caret leaves that
 * outermost link, the editor blurs, or the editor goes away. Ending on the innermost link proposed
 * while the user was still editing the link around it: an inner link edited and then the outer
 * text, or a completion accepted in an inner link, which leaves the caret between the two `]]`.
 *
 * At the end every link that was inside is paired with the link now occupying its range, and a
 * link proposes a rename when its name changed in a way its own changed inner links do not
 * explain: editing a scope renames the scoped concepts around it by the cascade (ADR 0038, read
 * with the cascade's own rule, `rewriteWikilinkScope`), so the outer link proposes only when its
 * own text changed too. A link newly typed during the edit was not there to pair, and one unlinked
 * or deleted pairs with nothing, so neither proposes for itself.
 * Proposals come outermost first, links at one depth in document order: the order the renames
 * run in, each with the names exactly as they were and as typed. Pure, so the rules are
 * unit-tested; the ViewPlugin in `wikilink.ts` feeds it.
 */

import { ChangeSet } from '@codemirror/state'

import { conceptKey } from '../../../storage/fs/identity'
import { parseWikilinks } from '../../wikilink/parser'
import { rewriteWikilinkScope } from '../../wikilink/rename'

/** A balanced wikilink at absolute offsets: `from` at its first `[`, `to` just past its last `]`. */
export interface LinkAt {
    concept: string
    from: number
    to: number
}

export interface WikilinkEpisodeUpdate {
    /** This user's own changes in this update, as `[from, to)` ranges of the OLD document. */
    localChanges: readonly { from: number; to: number }[]
    /** The balanced links on the OLD document's line holding `[from, to]`. */
    linksBefore: (from: number, to: number) => readonly LinkAt[]
    /** The balanced links on the NEW document's line holding `[from, to]`. */
    linksAfter: (from: number, to: number) => readonly LinkAt[]
    /** Map an old-document offset through this update's changes. */
    mapPos: (pos: number, assoc: -1 | 1) => number
    caret: number
    focused: boolean
}

/** A rename an ended episode proposes: the concept a link named, and what it names now. */
export interface WikilinkEdit {
    before: string
    after: string
}

/**
 * Whether an edit over `[from, to]` is an edit OF `link`. A link's editable text is what lies
 * between its brackets; the brackets are the edge of whatever encloses it. So a pure insertion
 * (`from === to`) counts only strictly between its `[[` and `]]`, which is what makes a space typed
 * at the seam where an inner link's `]]` meets the outer link's `]]` an edit of the outer link,
 * and one typed just outside a top-level link an edit of nothing. A deletion or replacement that
 * takes in a bracket still belongs to that bracket's link: its text is what changes shape.
 */
function isEditOf(link: LinkAt, from: number, to: number): boolean {
    return from === to ? from > link.from + 1 && from < link.to - 1 : link.from <= from && to <= link.to
}

/** The outermost link an edit over `[from, to]` is an edit OF, or null: the link an episode opens on. */
export function outermostLinkContainingEdit(links: readonly LinkAt[], from: number, to: number): LinkAt | null {
    let best: LinkAt | null = null
    for (const link of links) {
        if (!isEditOf(link, from, to)) continue
        if (!best || link.to - link.from > best.to - best.from) best = link
    }
    return best
}

/** A link inside the episode: as it was when the episode opened, and its range now. */
interface Tracked {
    concept: string
    /** Where it was when the episode opened, to find its parent. */
    from: number
    to: number
    /** Its range carried through every change since. */
    at: { from: number; to: number }
    /** The tracked link directly around it, or -1 for the outermost. */
    parent: number
    depth: number
}

export class WikilinkEpisode {
    /** The outermost link first, then every link inside it in document order. */
    #tracked: Tracked[] = []

    /** Whether a link has been touched and the episode has not yet ended. */
    get open(): boolean {
        return this.#tracked.length > 0
    }

    /** Feed one editor update. Returns the proposed renames when the episode ended, else none. */
    update(input: WikilinkEpisodeUpdate): readonly WikilinkEdit[] {
        if (!this.open && input.localChanges.length > 0) {
            const first = input.localChanges[0]
            const links = input.linksBefore(first.from, first.to)
            const outer = outermostLinkContainingEdit(links, first.from, first.to)
            if (outer) this.#tracked = track(outer, links)
        }
        if (!this.open) return []
        // Carry every range through this update's changes - the first change included. The
        // outermost link takes text typed at its edges (the caret cannot be there without having
        // left it); an inner link does not, because text typed just before its [[ or just after
        // its ]] is the text of the link around it, and typing on after a completion accepted in
        // the inner link does exactly that.
        for (const link of this.#tracked) {
            const [start, end] = link.depth === 0 ? ([-1, 1] as const) : ([1, -1] as const)
            link.at = { from: input.mapPos(link.at.from, start), to: input.mapPos(link.at.to, end) }
        }
        const outer = this.#tracked[0].at
        const inside = input.caret > outer.from && input.caret < outer.to
        if (inside && input.focused) return []
        return this.#end(input.linksAfter)
    }

    /** The editor is going away: whatever was touched is done with. */
    close(linksAfter: (from: number, to: number) => readonly LinkAt[]): readonly WikilinkEdit[] {
        return this.open ? this.#end(linksAfter) : []
    }

    #end(linksAfter: (from: number, to: number) => readonly LinkAt[]): readonly WikilinkEdit[] {
        const tracked = this.#tracked
        this.#tracked = []
        return proposals(tracked, linksAfter(tracked[0].at.from, tracked[0].at.to))
    }
}

/** The episode's links: `outer` and every link inside it, each with its parent and depth. */
function track(outer: LinkAt, links: readonly LinkAt[]): Tracked[] {
    // The parser's order - by start, and the longer first on a shared start - puts every link
    // after any link around it, so a parent is always already in the list.
    const inside = links
        .filter((link) => link.from >= outer.from && link.to <= outer.to)
        .sort((a, b) => a.from - b.from || b.to - a.to)
    const tracked: Tracked[] = []
    for (const link of inside) {
        let parent = -1
        for (let i = tracked.length - 1; i >= 0; i--) {
            if (tracked[i].from <= link.from && link.to <= tracked[i].to) {
                parent = i
                break
            }
        }
        tracked.push({ ...link, at: { from: link.from, to: link.to }, parent, depth: parent < 0 ? 0 : tracked[parent].depth + 1 })
    }
    return tracked
}

/** What an ended episode proposes, outermost first, links at one depth in document order. */
function proposals(tracked: readonly Tracked[], after: readonly LinkAt[]): WikilinkEdit[] {
    // Pair each link with the innermost link now holding its range. Parents come first, so an
    // outer link claims its own; an inner link whose range only an outer link holds now was
    // unlinked, and pairs with nothing. A deleted link's range has closed up and pairs with
    // nothing either, rather than with whatever link touches the point it left. And an inner
    // link's partner lies inside its parent's brackets: with one of its own brackets deleted,
    // its other bracket can close the parent's `[[` instead, and that link is not its partner.
    const claimed = new Set<LinkAt>()
    const now: (string | null)[] = tracked.map((link) => {
        if (link.at.from >= link.at.to) return null
        const parent = link.parent < 0 ? null : tracked[link.parent].at
        let best: LinkAt | null = null
        for (const candidate of after) {
            if (candidate.from > link.at.from || candidate.to < link.at.to) continue
            if (parent && (candidate.from < parent.from + 2 || candidate.to > parent.to - 2)) continue
            if (!best || candidate.to - candidate.from < best.to - best.from) best = candidate
        }
        if (!best || claimed.has(best)) return null
        claimed.add(best)
        return best.concept
    })

    const edits: { edit: WikilinkEdit; depth: number; from: number }[] = []
    tracked.forEach((link, index) => {
        const after = now[index]
        if (after === null || conceptKey(after) === conceptKey(link.concept)) return
        if (conceptKey(explained(tracked, now, index)) === conceptKey(after)) return
        edits.push({ edit: { before: link.concept, after }, depth: link.depth, from: link.from })
    })
    edits.sort((a, b) => a.depth - b.depth || a.from - b.from)

    // One rename per old name: a link that names the same concept twice, edited both ways, can
    // only be renamed one way, and the first edit of it is the one taken.
    const seen = new Set<string>()
    return edits
        .map(({ edit }) => edit)
        .filter((edit) => {
            const key = conceptKey(edit.before)
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
}

/**
 * The name the link at `index` would have now if only its inner links had been renamed: its old
 * name put through each changed direct child's rename by the cascade's own rule, which replaces
 * every `[[old]]` at any depth (`rewriteWikilinkScope`). A link whose name is this has nothing of
 * its own to propose. A child that pairs with nothing (unlinked or deleted) renames nothing, so
 * the parent then proposes; so does a parent naming one scope twice and edited only once, since
 * renaming that scope renames both.
 */
function explained(tracked: readonly Tracked[], now: readonly (string | null)[], index: number): string {
    let name = tracked[index].concept
    tracked.forEach((child, i) => {
        const renamed = now[i]
        if (child.parent !== index || renamed === null || conceptKey(renamed) === conceptKey(child.concept)) return
        name = rewriteWikilinkScope(name, child.concept, renamed).text
    })
    return name
}

/**
 * The renames a name typed in place of another proposes (ADR 0065, amended 2026-10-04): the two
 * names read as the text of one link edited from one to the other, by the rules above. A page's
 * Rename dialog and its title in the frontmatter take a whole name rather than keystrokes, so the
 * edit is taken to be the text between the names' longest shared start and end, and is paired as
 * an edit in the editor would be. A changed scope proposes the scope, which carries the name
 * around it by the cascade, and the name proposes for itself only for text of its own.
 */
export function renamesProposedByName(before: string, after: string): WikilinkEdit[] {
    const old = `[[${before}]]`
    const next = `[[${after}]]`
    let start = 0
    while (start < old.length && start < next.length && old[start] === next[start]) start++
    if (start === old.length && start === next.length) return []
    let end = 0
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++
    const edit = { from: start, to: old.length - end, insert: next.slice(start, next.length - end) }
    const changes = ChangeSet.of([edit], old.length)
    const linksIn = (text: string): LinkAt[] => parseWikilinks(text).map((link) => ({ concept: link.concept, from: link.start, to: link.end + 1 }))
    // The edit is over once it is made: the caret is outside the link, as when it leaves one.
    const edits = new WikilinkEpisode().update({
        localChanges: [{ from: edit.from, to: edit.to }],
        linksBefore: () => linksIn(old),
        linksAfter: () => linksIn(next),
        mapPos: (pos, assoc) => changes.mapPos(pos, assoc),
        caret: next.length,
        focused: false,
    })
    return [...edits]
}
