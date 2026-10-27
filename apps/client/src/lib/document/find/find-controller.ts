/**
 * One View's [[Find and Replace]] (ADR 0153): the query, the [[Match]]es in the editor it finds
 * in, which match is current, and the replaces. The box (`FindBox.svelte`) and the [[Match List]]
 * (`MatchList.svelte`) draw a snapshot of this and call its methods. Nothing here touches the DOM.
 *
 * A View's find follows the editor it is pointed at: the tab's own, or in a [[Journal Roll]] the
 * older day the caret went into (`retarget`). The matches are worked out from that editor's state
 * and sent to it to draw (`showFindMatches`). The current match is the editor's selection. The
 * editor carries the matches through every change and knows whether the selection is still the
 * one find put on the current match (`findState`), so this reads positions from there: its own
 * copy is only as new as its last search.
 *
 * Plain TypeScript with a subscription rather than runes, so every behaviour is unit-tested in
 * Node against a headless editor.
 */

import type { EditorState, Transaction, TransactionSpec } from '@codemirror/state'

import { findState, type FindRange, selectMatch, showFindMatches } from '../view/augmentations/find-highlight'

import { type FindOptions, type FindQuery, findMatches, type Match, type MatchLine, matchLines, nearestMatch } from './find-matches'
import { planReplace, type ReplacePlan, replaceTransaction } from './find-replace'
import type { FindLayout, FindSession } from './find-session'
import type { ReplaceMode, ReplaceOutcome, ReplaceRequest } from './replace-question'

/** What find needs of an editor: an `EditorView` is one. */
export interface FindTarget {
    readonly state: EditorState
    dispatch(tr: Transaction | TransactionSpec): void
    focus(): void
}

export interface FindSnapshot {
    open: boolean
    replaceShown: boolean
    search: string
    replace: string
    options: FindOptions
    matches: readonly Match[]
    /** The Match List's rows, worked out with the matches so they read the same text. */
    rows: readonly MatchLine[]
    /** More lines match than the Match List shows. */
    truncated: boolean
    /** The index of the current match, or -1. */
    current: number
    /** Why the regular expression cannot be used, or null. */
    error: string | null
    /** What the last replace did, or what is being waited for, or null. */
    status: string | null
    /** A replace is waiting on the rename question or running: the replace buttons do nothing. */
    busy: boolean
    listShown: boolean
    /** The document find is in. */
    target: string | null
    /** The body is ciphertext (locked or masked): only the frontmatter is read. */
    bodyLocked: boolean
    /** A replace can write the body. */
    writable: boolean
    /** Bumped each time the box should take focus and select its query. */
    focusRequest: number
}

export interface FindControllerDeps {
    session: FindSession
    layout(): FindLayout
    /** The workspace's question for a replace that renames, or null where there is no workspace. */
    replaceRenames(): ((request: ReplaceRequest) => Promise<ReplaceOutcome>) | null
    /** Whether the editor's body takes an edit now (`bodyWritable`). */
    writable(state: EditorState): boolean
    /** Whether the body is a locked or masked Protected Document's ciphertext. */
    bodyLocked(state: EditorState): boolean
    /**
     * Whether the editor is a [[Protected Document]]'s. A query typed there can be a secret, so it is
     * never kept for the session, and the box forgets it when the document locks.
     */
    protectedDocument(state: EditorState): boolean
    /** Whether the editor is still on the page: an older day hidden from a Journal Roll is not. */
    alive(target: FindTarget): boolean
    /** The editor to find in when the one find was in has gone: the tab's own. */
    fallback(): FindTarget | null
    /** The document an editor shows. */
    documentOf(target: FindTarget): string | null
    /** The undo key as this keyboard writes it, for the note after a rename. */
    undoKey: string
    /** How long a wait runs before the box says what it is waiting for, so a fast one never flashes. */
    busyDelayMs?: number
}

/** The note after a replace that renamed: what Ctrl+Z restores, and what it does not (ADR 0124). */
export function renamedNote(undoKey: string): string {
    return `${undoKey} restores this document's text. To reverse a rename, rename it back.`
}

/** Said when the editor find was in has gone, and find moved to the tab's own entry. */
export const TARGET_GONE_MESSAGE = 'The day you were finding in has closed. Find is now in this entry.'

/** Said when the match a replace was about changed before the replace could write it. */
export const MATCH_CHANGED_MESSAGE = 'The match changed while the question was open. Nothing was replaced.'

/** Why a single replace left the current match as it is. */
export const KEPT_MESSAGE = {
    name: "This match is one of the page's names. Rename the page, or edit the alias, to change it.",
    edge: 'This match is a frontmatter delimiter, which a replace leaves as it is.',
} as const

export class FindController {
    readonly #deps: FindControllerDeps
    readonly #listeners = new Set<() => void>()
    #target: FindTarget | null = null
    #snapshot: FindSnapshot

    constructor(deps: FindControllerDeps) {
        this.#deps = deps
        this.#snapshot = {
            open: false,
            replaceShown: false,
            search: '',
            replace: '',
            options: deps.session.options(),
            matches: [],
            rows: [],
            truncated: false,
            current: -1,
            error: null,
            status: null,
            busy: false,
            listShown: deps.session.listShown(deps.layout()),
            target: null,
            bodyLocked: false,
            writable: true,
            focusRequest: 0,
        }
    }

    get snapshot(): FindSnapshot {
        return this.#snapshot
    }

    /** The editor find is in, or null while closed. */
    get target(): FindTarget | null {
        return this.#snapshot.open ? this.#target : null
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    #set(changes: Partial<FindSnapshot>): void {
        this.#snapshot = { ...this.#snapshot, ...changes }
        for (const listener of this.#listeners) listener()
    }

    #query(): FindQuery {
        return { search: this.#snapshot.search, replace: this.#snapshot.replace, ...this.#snapshot.options }
    }

    /**
     * Open on `target`, or bring the open box to it. A one-line selection becomes the query, as in
     * every editor. Otherwise the box keeps what it holds, or opens with the session's last query.
     */
    open(target: FindTarget, options: { replace: boolean }): void {
        const selection = target.state.selection.main
        const selected = target.state.sliceDoc(selection.from, selection.to)
        // Mod+F again with the current match selected keeps the query: the match's own text is not
        // the query when it was found without case or by a regular expression.
        const onCurrent = this.#snapshot.open && target === this.#target && this.#onCurrent()
        const seed = !onCurrent && !selection.empty && !selected.includes('\n') ? selected : this.#snapshot.search || this.#deps.session.lastQuery()
        this.#point(target)
        this.#set({
            open: true,
            // As it is now: only a lock that comes while the box is open closes it.
            bodyLocked: this.#deps.bodyLocked(target.state),
            replaceShown: this.#snapshot.replaceShown || options.replace,
            search: seed,
            status: null,
            listShown: this.#deps.session.listShown(this.#deps.layout()),
            focusRequest: this.#snapshot.focusRequest + 1,
        })
        this.#refresh({ from: selection.from, select: true })
    }

    /** Hand focus back to the box's query, as it is (Esc in the Match List). */
    focusBox(): void {
        if (this.#snapshot.open) this.#set({ focusRequest: this.#snapshot.focusRequest + 1 })
    }

    /** The caret went into another editor of this View (a Journal Roll's day): find there. */
    retarget(target: FindTarget): void {
        if (!this.#snapshot.open || target === this.#target) return
        this.#point(target)
        this.#refresh({ from: target.state.selection.main.head, select: false })
    }

    /** The editor find was in has gone. */
    targetGone(target: FindTarget): void {
        if (target === this.#target) this.close({ focusEditor: false })
    }

    /**
     * The editor find was in is being rebuilt (a Draft becoming a page, a lock or an unlock): let go
     * of it without closing, so the box keeps its query and finds in the new editor (`retarget`).
     */
    release(target: FindTarget): void {
        if (target === this.#target) this.#target = null
    }

    close(options: { focusEditor: boolean }): void {
        if (!this.#snapshot.open) return
        const target = this.#target
        const secret = !!target && this.#deps.protectedDocument(target.state)
        this.#remember()
        this.#set({
            open: false,
            status: null,
            matches: [],
            rows: [],
            truncated: false,
            current: -1,
            error: null,
            // A query typed into a Protected Document is not kept for the next box.
            ...(secret ? { search: '', replace: '' } : {}),
        })
        if (target && this.#deps.alive(target)) {
            target.dispatch({ effects: showFindMatches.of(null) })
            if (options.focusEditor) target.focus()
        }
    }

    setSearch(search: string): void {
        this.#live()
        this.#set({ search, status: null })
        this.#refresh({ from: this.#target?.state.selection.main.from ?? 0, select: true })
    }

    setReplace(replace: string): void {
        this.#set({ replace, status: null })
    }

    toggleOption(option: keyof FindOptions): void {
        this.#live()
        const options = { ...this.#snapshot.options, [option]: !this.#snapshot.options[option] }
        this.#deps.session.setOptions(options)
        this.#set({ options, status: null })
        this.#refresh({ from: this.#target?.state.selection.main.from ?? 0, select: true })
    }

    showReplace(shown: boolean): void {
        this.#set({ replaceShown: shown })
    }

    setListShown(shown: boolean): void {
        this.#deps.session.setListShown(this.#deps.layout(), shown)
        this.#set({ listShown: shown })
    }

    /** Step through the session's earlier queries (Up and Down in the box). */
    stepHistory(direction: -1 | 1): void {
        const search = this.#deps.session.step(this.#snapshot.search, direction)
        if (search !== this.#snapshot.search) this.setSearch(search)
    }

    /**
     * The text changed under find: work the matches out again, the current one kept where it was.
     * Called after the editor's update, never from inside it, since this dispatches to the editor.
     */
    textChanged(): void {
        if (!this.#snapshot.open || !this.#target || !this.#live()) return
        const { ranges, current } = findState(this.#target.state)
        this.#refresh({ from: ranges[current]?.from ?? this.#target.state.selection.main.head, select: false })
    }

    next(): void {
        this.#step(1)
    }

    previous(): void {
        this.#step(-1)
    }

    /** The first match on the next line that has one, wrapping (F4). */
    nextLine(): void {
        this.#stepLine(1)
    }

    /** The first match on the previous line that has one, wrapping (Shift+F4). */
    previousLine(): void {
        this.#stepLine(-1)
    }

    /** Make the match at `index` current and put the selection on it (a Match List row). */
    goTo(index: number): void {
        if (!this.#live() || index < 0 || index >= this.#ranges().length) return
        this.#remember()
        this.#select(index)
    }

    /**
     * Replace the current match, then go to the next. With the selection elsewhere, the first press
     * goes to the match nearest the caret instead, as every editor's does, so a replace never lands
     * on a match the person has not seen.
     */
    async replaceOne(): Promise<void> {
        const target = this.#target
        if (!target || !this.#live() || this.#snapshot.busy || !this.#snapshot.writable) return
        const ranges = this.#ranges()
        if (ranges.length === 0) return
        this.#remember()
        if (!this.#onCurrent()) {
            this.#select(matchAtOrAfter(ranges, target.state.selection.main.from))
            return
        }
        const current = findState(target.state).current
        const keep = this.#snapshot.matches[current]?.keep
        if (keep) {
            this.#set({ status: KEPT_MESSAGE[keep] })
            return
        }
        await this.#replace(target, 'one')
    }

    async replaceAll(): Promise<void> {
        const target = this.#target
        if (!target || !this.#live() || this.#snapshot.busy || !this.#snapshot.writable || this.#snapshot.matches.length === 0) return
        this.#remember()
        await this.#replace(target, 'all')
    }

    /**
     * Whether the editor find is in is still on the page. One that has gone (an older day hidden
     * from a Journal Roll, whose last word never reached the View) is let go, and find moves to
     * the tab's own editor and says so. A dead editor still takes a dispatch, which would look like
     * a replace that worked and was never saved.
     */
    #live(): boolean {
        const target = this.#target
        if (!target || this.#deps.alive(target)) return true
        this.#target = null
        const fallback = this.#deps.fallback()
        if (fallback && this.#deps.alive(fallback)) {
            this.retarget(fallback)
            this.#set({ status: TARGET_GONE_MESSAGE })
        } else {
            this.close({ focusEditor: false })
        }
        return false
    }

    /** Keep the query for the session, unless it was typed into a Protected Document. */
    #remember(): void {
        const target = this.#target
        if (target && this.#deps.alive(target) && this.#deps.protectedDocument(target.state)) return
        this.#deps.session.remember(this.#snapshot.search)
    }

    #point(target: FindTarget): void {
        const previous = this.#target
        if (previous && previous !== target && this.#deps.alive(previous)) previous.dispatch({ effects: showFindMatches.of(null) })
        this.#target = target
    }

    /** The matches' places now, carried through every change since the last search. */
    #ranges(): readonly FindRange[] {
        return this.#target ? findState(this.#target.state).ranges : []
    }

    /** Whether the selection is the one find put on the current match. */
    #onCurrent(): boolean {
        if (!this.#target) return false
        const { current, selected } = findState(this.#target.state)
        return selected && current >= 0
    }

    /**
     * Work the matches out against the editor's state and show them. The current match becomes the
     * first at or after `from`; with `select` the selection goes onto it. A document that locks
     * while find is open closes it, and the query typed into it is forgotten.
     */
    #refresh(options: { from: number; select: boolean }): void {
        const target = this.#target
        if (!target) return
        const bodyLocked = this.#deps.bodyLocked(target.state)
        if (this.#snapshot.open && bodyLocked && !this.#snapshot.bodyLocked && this.#snapshot.target === this.#deps.documentOf(target)) {
            this.close({ focusEditor: false })
            this.#set({ search: '', replace: '', bodyLocked: true })
            return
        }
        const { matches, error } = findMatches(target.state, this.#query())
        const current = nearestMatch(matches, options.from)
        const { rows, truncated } = matchLines(target.state, matches)
        this.#set({
            matches,
            rows,
            truncated,
            current,
            error,
            target: this.#deps.documentOf(target),
            writable: this.#deps.writable(target.state),
            bodyLocked,
        })
        target.dispatch({ effects: showFindMatches.of({ ranges: matches, current }) })
        if (options.select && current >= 0) target.dispatch(selectMatch(target.state, matches[current], current))
    }

    /** Make the match at `index` current, with the selection on it, in one step. */
    #select(index: number): void {
        const target = this.#target
        const range = this.#ranges()[index]
        if (!target || !range) return
        this.#set({ current: index, status: null })
        target.dispatch(selectMatch(target.state, range, index))
    }

    #step(direction: 1 | -1): void {
        const target = this.#target
        if (!target || !this.#live()) return
        const ranges = this.#ranges()
        if (ranges.length === 0) return
        this.#remember()
        const { current } = findState(target.state)
        let index: number
        if (this.#onCurrent()) {
            index = (current + direction + ranges.length) % ranges.length
        } else if (direction > 0) {
            index = nearestMatch(ranges, target.state.selection.main.head)
        } else {
            // The last match that starts before the selection, wrapping to the last one.
            const before = ranges.findLastIndex((range) => range.from < target.state.selection.main.from)
            index = before < 0 ? ranges.length - 1 : before
        }
        this.#select(index)
    }

    #stepLine(direction: 1 | -1): void {
        if (!this.#live()) return
        const { matches } = this.#snapshot
        if (matches.length === 0 || !this.#target) return
        const current = findState(this.#target.state).current
        const line = matches[Math.max(0, current)]?.line ?? 0
        const lines = [...new Set(matches.map((match) => match.line))]
        const at = lines.indexOf(line)
        const nextLine = lines[(at + direction + lines.length) % lines.length]
        this.#remember()
        this.#select(matches.findIndex((match) => match.line === nextLine))
    }

    /**
     * Plan the replace against the editor as it is now. A single replace finds its match again by
     * place, as the editor has carried it, so an edit made meanwhile cannot point it at other text.
     * Null when that match is no longer there.
     */
    #plan(target: FindTarget, scope: 'one' | 'all', outsideLinks: boolean): ReplacePlan | null {
        const query = this.#query()
        const { matches } = findMatches(target.state, query)
        if (scope === 'all') return planReplace(target.state, query, matches, { scope: { kind: 'all' }, outsideLinks })
        const { ranges, current } = findState(target.state)
        const at = ranges[current]
        const index = at ? matches.findIndex((match) => match.from === at.from && match.to === at.to) : -1
        if (index < 0) return null
        return planReplace(target.state, query, matches, { scope: { kind: 'one', index }, outsideLinks })
    }

    async #replace(target: FindTarget, scope: 'one' | 'all'): Promise<void> {
        const first = this.#plan(target, scope, false)
        if (!first) return
        if (first.replaced === 0) {
            this.#set({ status: first.kept > 0 ? "Nothing to replace. These matches are the page's names or the frontmatter's delimiters, which a replace leaves as they are." : 'Nothing to replace.' })
            return
        }
        // What the replace wrote, and where its match was, for the status and the next match.
        let applied: { plan: ReplacePlan; at: FindRange | null } | null = null
        let changed = false
        const apply = (mode: ReplaceMode): boolean => {
            if (!this.#deps.alive(target)) return false
            const at = scope === 'one' ? (findState(target.state).ranges[findState(target.state).current] ?? null) : null
            const plan = this.#plan(target, scope, mode === 'outside-links')
            if (!plan) {
                changed = true
                return false
            }
            applied = { plan, at }
            if (plan.replaced === 0) return true
            const before = target.state.doc
            target.dispatch(replaceTransaction(target.state, plan))
            return target.state.doc !== before
        }

        const ask = this.#deps.replaceRenames()
        let outcome: ReplaceOutcome
        if (!ask || first.edits.length === 0) {
            outcome = apply('all') ? { kind: 'replaced', renamed: false } : { kind: 'refused' }
        } else {
            this.#set({ busy: true, status: null })
            const waiting = setTimeout(() => {
                if (this.#snapshot.busy) this.#set({ status: 'Checking where the link names are used…' })
            }, this.#deps.busyDelayMs ?? 400)
            try {
                outcome = await ask({
                    target: this.#deps.documentOf(target) ?? '',
                    plan: () => {
                        const plan = this.#plan(target, scope, false)
                        // The match has gone: nothing is left to ask, and applying says so.
                        return plan ? { edits: plan.edits, textAfter: plan.textAfter, replaced: plan.replaced } : { edits: [], textAfter: target.state.doc.toString(), replaced: 0 }
                    },
                    apply,
                })
            } finally {
                clearTimeout(waiting)
                this.#set({ busy: false })
            }
        }
        this.#finish(target, scope, outcome, applied, changed)
    }

    /** After a replace: the matches again, the next one current after a single replace, and what happened. */
    #finish(target: FindTarget, scope: 'one' | 'all', outcome: ReplaceOutcome, applied: { plan: ReplacePlan; at: FindRange | null } | null, changed: boolean): void {
        if (outcome.kind === 'cancelled') {
            this.#set({ status: null })
            return
        }
        if (!this.#live()) {
            this.#set({ status: TARGET_GONE_MESSAGE })
            return
        }
        if (changed) {
            this.textChanged()
            this.#set({ status: MATCH_CHANGED_MESSAGE })
            return
        }
        if (outcome.kind === 'refused' || !applied) {
            this.#set({ status: 'Nothing was replaced. The editor refused the edit.' })
            return
        }
        const { plan, at } = applied
        // After one replace, the next match is the first after the text that replaced it, or, with
        // nothing replaced (the match was in a wikilink, left by Replace outside wikilinks only),
        // the first after the match.
        const after = at ? (plan.replaced > 0 ? at.from + (plan.changes[0]?.insert.length ?? 0) : at.to) : target.state.selection.main.from
        this.#refresh({ from: after, select: scope === 'one' })
        this.#set({ status: replaceStatus(plan, scope, outcome.renamed, this.#deps.undoKey) })
    }
}

/** The match the caret is in, or else the first after it, wrapping. */
function matchAtOrAfter(ranges: readonly FindRange[], pos: number): number {
    const holding = ranges.findIndex((range) => range.from <= pos && pos < range.to)
    return holding >= 0 ? holding : nearestMatch(ranges, pos)
}

/** What a replace did, in a line for the status: what changed, what was left, and what undo does. */
export function replaceStatus(plan: ReplacePlan, scope: 'one' | 'all', renamed: boolean, undoKey: string): string | null {
    const parts: string[] = []
    if (scope === 'all') parts.push(`Replaced ${plan.replaced}.`)
    const names = plan.keptNames
    const edges = plan.kept - plan.keptNames
    if (names > 0) parts.push(names === 1 ? "Left 1 of the page's names unchanged." : `Left ${names} of the page's names unchanged.`)
    if (edges > 0) parts.push(edges === 1 ? 'Left 1 frontmatter delimiter unchanged.' : `Left ${edges} frontmatter delimiters unchanged.`)
    if (plan.skippedInLinks > 0) parts.push(`Left ${plan.skippedInLinks} in wikilinks unchanged.`)
    if (plan.linksRemoved > 0) parts.push(plan.linksRemoved === 1 ? 'Removed 1 wikilink.' : `Removed ${plan.linksRemoved} wikilinks.`)
    if (renamed) parts.push(renamedNote(undoKey))
    return parts.length > 0 ? parts.join(' ') : null
}
