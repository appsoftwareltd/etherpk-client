/**
 * What a [[Find and Replace]] replace does to one document (ADR 0153): the changes, the text it
 * leaves, and what it proposes about wikilinks.
 *
 * A replace that changes the name in a wikilink proposes what an edited link proposes (ADR 0065):
 * each changed link is paired with the link now at its range by the editor's own episode rules
 * (`WikilinkEpisode`), so a changed scope proposes the scope, and a link the replace unlinks or
 * creates proposes nothing for itself. The box asks those questions before it dispatches anything,
 * which is why the plan is worked out against a state the replace has not touched.
 *
 * Pure: the plan is computed from an `EditorState` and the matches, and `replaceTransaction` builds
 * the one transaction that applies it.
 */

import { ChangeSet, type EditorState, type Transaction } from '@codemirror/state'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'
import { conceptKey } from '$lib/storage/fs/identity'

import { type FrontmatterIdentity, frontmatterIdentity } from '../frontmatter/identity'

import { linksOnLineAt } from '../view/augmentations/wikilink'
import { type LinkAt, outermostLinkContainingEdit, WikilinkEpisode, type WikilinkEdit } from '../view/augmentations/wikilink-episode'
import { FIND_REPLACE_ALL_EVENT, FIND_REPLACE_EVENT } from './find-edit'
import type { FindQuery, Match } from './find-matches'

/** Which matches a replace changes: every one, or the one at `index`. */
export type ReplaceScope = { kind: 'all' } | { kind: 'one'; index: number }

export interface ReplaceOptions {
    scope: ReplaceScope
    /** Leave every match that touches a wikilink as it is (**Replace outside wikilinks only**). */
    outsideLinks: boolean
}

export interface ReplacePlan {
    /** The changes, in document order, against the state the plan was made from. */
    changes: readonly { from: number; to: number; insert: string }[]
    /** Whether the plan replaces one match or all of them, for the edit's user event. */
    scope: ReplaceScope['kind']
    /** How many matches the replace changes. */
    replaced: number
    /** How many matches in scope it leaves because they are a name or a frontmatter delimiter. */
    kept: number
    /** How many of those are the document's names. */
    keptNames: number
    /** How many matches in scope it leaves because they touch a wikilink (outside-links mode). */
    skippedInLinks: number
    /** The renames the replace proposes, outermost first, one per old name. */
    edits: readonly WikilinkEdit[]
    /** How many wikilinks on the lines it changes are gone afterwards. */
    linksRemoved: number
    /** The document's text as the replace leaves it. */
    textAfter: string
}

/** Plan a replace of `matches` (all of `query`'s, as `findMatches` gave them) in `state`. */
export function planReplace(state: EditorState, query: FindQuery, matches: readonly Match[], options: ReplaceOptions): ReplacePlan {
    const inScope = options.scope.kind === 'all' ? matches : matches.slice(options.scope.index, options.scope.index + 1)
    const changes: { from: number; to: number; insert: string }[] = []
    let kept = 0
    let keptNames = 0
    let skippedInLinks = 0
    for (const match of inScope) {
        if (match.keep) {
            kept++
            if (match.keep === 'name') keptNames++
            continue
        }
        if (options.outsideLinks && touchesLink(state, match)) {
            skippedInLinks++
            continue
        }
        changes.push({ from: match.from, to: match.to, insert: replacementFor(query, match) })
    }
    // The name lines are kept by line, but a replace can reach the names another way: a key
    // renamed into `aliases`, or into a key the block already has, which leaves it unreadable. When
    // the names would change at all, the replace leaves the frontmatter as it is (ADR 0153 §3).
    const blockEnd = frontmatterSpan(state.doc.toString())?.end ?? 0
    if (blockEnd > 0 && changes.some((change) => change.from < blockEnd)) {
        const after = ChangeSet.of(changes, state.doc.length, state.lineBreak).apply(state.doc).toString()
        if (!sameIdentity(frontmatterIdentity(state.doc.toString()), frontmatterIdentity(after))) {
            const inBlock = changes.filter((change) => change.from < blockEnd).length
            changes.splice(0, changes.length, ...changes.filter((change) => change.from >= blockEnd))
            kept += inBlock
            keptNames += inBlock
        }
    }
    const changeSet = ChangeSet.of(changes, state.doc.length, state.lineBreak)
    // No filters: the plan is what the text becomes. The guards judge the real transaction later.
    const after = state.update({ changes: changeSet, filter: false }).state
    return {
        changes,
        scope: options.scope.kind,
        replaced: changes.length,
        kept,
        keptNames,
        skippedInLinks,
        edits: proposedRenames(state, after, changes, changeSet),
        linksRemoved: linksRemovedBy(state, after, changes, changeSet),
        textAfter: after.doc.toString(),
    }
}

/** The one transaction that applies `plan`, marked as a replace (`find-edit.ts`). */
export function replaceTransaction(state: EditorState, plan: ReplacePlan): Transaction {
    return state.update({
        changes: plan.changes,
        userEvent: plan.scope === 'all' ? FIND_REPLACE_ALL_EVENT : FIND_REPLACE_EVENT,
        scrollIntoView: plan.scope === 'one',
    })
}

/**
 * The text that replaces `match`. A plain query's replacement is literal. A regular expression's
 * reads `\n`, `\r`, `\t` and `\\` as their characters and fills `$&`, `$1`… and `$$`, as
 * `@codemirror/search` does, a missing group giving nothing.
 */
export function replacementFor(query: FindQuery, match: Match): string {
    if (!query.regexp || !match.captures) return query.replace
    const captures = match.captures
    const template = query.replace.replace(/\\([nrt\\])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\'))
    return template.replace(/\$([$&]|\d+)/g, (whole, name: string) => {
        if (name === '&') return captures[0]
        if (name === '$') return '$'
        // `$12` is group 12 when there is one, else group 1 and a literal 2.
        for (let length = name.length; length > 0; length--) {
            const group = Number(name.slice(0, length))
            if (group > 0 && group < captures.length) return captures[group] + name.slice(length)
        }
        return whole
    })
}

/** Whether two readings of a block name the document the same way. */
function sameIdentity(a: FrontmatterIdentity, b: FrontmatterIdentity): boolean {
    return (
        a.hasBlock === b.hasBlock &&
        a.readable === b.readable &&
        a.title === b.title &&
        a.hasAliasesKey === b.hasAliasesKey &&
        a.aliases.length === b.aliases.length &&
        a.aliases.every((alias, i) => alias === b.aliases[i])
    )
}

/** The balanced links on `line` (1-based) of `state`, outside code and the frontmatter. */
function linksOnLine(state: EditorState, line: number): LinkAt[] {
    const start = state.doc.line(line).from
    return linksOnLineAt(state, start, start)
}

/** Whether `match` overlaps any wikilink on the lines it covers. */
function touchesLink(state: EditorState, match: Match): boolean {
    const last = state.doc.lineAt(match.to).number
    for (let line = match.line; line <= last; line++) {
        if (linksOnLine(state, line).some((link) => match.from < link.to && match.to > link.from)) return true
    }
    return false
}

/**
 * The renames the changes propose, by the editor's own episode rules: the changes grouped by the
 * outermost link each is an edit of, each group read as one ended episode in that link.
 * Outermost first within a link, links in document order, and one rename per old name, the first
 * kept, as within one episode.
 */
function proposedRenames(before: EditorState, after: EditorState, changes: readonly { from: number; to: number }[], changeSet: ChangeSet): WikilinkEdit[] {
    const groups = new Map<string, { from: number; to: number }[]>()
    for (const change of changes) {
        const outer = outermostLinkContainingEdit(linksOnLineAt(before, change.from, change.to), change.from, change.to)
        if (!outer) continue
        const key = `${outer.from}:${outer.to}`
        groups.set(key, [...(groups.get(key) ?? []), { from: change.from, to: change.to }])
    }
    const edits: WikilinkEdit[] = []
    const seen = new Set<string>()
    for (const localChanges of groups.values()) {
        const ended = new WikilinkEpisode().update({
            localChanges,
            linksBefore: (from, to) => linksOnLineAt(before, from, to),
            linksAfter: (from, to) => linksOnLineAt(after, from, to),
            mapPos: (pos, assoc) => changeSet.mapPos(pos, assoc),
            // The replace is done once it is made, as an edit is when the caret leaves the link.
            caret: -1,
            focused: false,
        })
        for (const edit of ended) {
            const key = conceptKey(edit.before)
            if (seen.has(key)) continue
            seen.add(key)
            edits.push(edit)
        }
    }
    return edits
}

/** How many links on the changed lines are gone after the changes: unlinked, broken or joined. */
function linksRemovedBy(before: EditorState, after: EditorState, changes: readonly { from: number; to: number }[], changeSet: ChangeSet): number {
    const linesBefore = new Set<number>()
    const linesAfter = new Set<number>()
    for (const change of changes) {
        for (let line = before.doc.lineAt(change.from).number; line <= before.doc.lineAt(change.to).number; line++) linesBefore.add(line)
        const from = changeSet.mapPos(change.from, -1)
        const to = changeSet.mapPos(change.to, 1)
        for (let line = after.doc.lineAt(from).number; line <= after.doc.lineAt(to).number; line++) linesAfter.add(line)
    }
    const count = (state: EditorState, lines: Set<number>) => [...lines].reduce((sum, line) => sum + linksOnLine(state, line).length, 0)
    return Math.max(0, count(before, linesBefore) - count(after, linesAfter))
}
