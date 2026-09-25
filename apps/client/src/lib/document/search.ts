/**
 * [[Search]] (CONTEXT.md): the state behind the modal.
 *
 * A plain observable rather than a rune store, so it can be driven from a command handler
 * outside any component — and so the whole thing unit-tests without a DOM.
 *
 * The shape follows the one fact that dominates this feature: the two groups are **not**
 * symmetrical. Names are answered from the in-memory snapshot the index worker pushes, with
 * no message boundary at all; text is a worker round trip. Names will always land first. The
 * design leans into that rather than trying to synchronise them, which is why they debounce
 * separately, page separately, and render as two independently-arriving groups.
 */

import type { SearchDocumentGroup } from './index-db'
import { rankQuickFind, type QuickFindRow } from './quick-find'
import { isSearchableTextQuery } from './search-query'

/** Rows of names per page. Five, because Names is a jump list, not something to page through. */
export const NAME_PAGE_SIZE = 5

/** Document groups per page of text results. */
export const TEXT_PAGE_SIZE = 10

/** Matches Quick Find's constant, so the two feel identical. */
export const NAME_DEBOUNCE_MS = 120

/** Longer than names: every keystroke is a worker round trip and an FTS query. */
export const TEXT_DEBOUNCE_MS = 250

/**
 * How often an index change may re-run an open Search.
 *
 * A THROTTLE, not a debounce. Opening a [[Knowledge Graph]] re-verifies every document, so
 * `onUpdated` arrives as a long burst — and a burst that keeps resetting a debounce would
 * starve the re-run entirely. A throttle guarantees one run per window however long the burst
 * lasts.
 */
export const REFRESH_THROTTLE_MS = 250

export type TextStatus =
    | { kind: 'idle' }
    | { kind: 'too-short' }
    | { kind: 'building'; done: number; total: number }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'failed'; message: string }

export interface SearchState {
    open: boolean
    query: string
    /** Names, already paged. Answered synchronously, so it has no loading state of its own. */
    nameRows: QuickFindRow[]
    namePage: number
    nameTotal: number
    /** True while the index is still building — names are as partial as text is. */
    nameBuilding: boolean
    textGroups: SearchDocumentGroup[]
    /** The page asked for, which the pager shows at once. */
    textPage: number
    /**
     * The page `textGroups` and `textHasMore` belong to. It trails `textPage` while a page
     * request is in flight, and that gap is what stops a held → key running on past the last
     * page before any answer has said it is the last.
     */
    textShownPage: number
    textHasMore: boolean
    /** Capped; `textCountCapped` says the real number is higher. */
    textCount: number
    textCountCapped: boolean
    textStatus: TextStatus
    /** True when the graph holds encrypted content, so the Text group can say it is skipped. */
    hasEncryptedContent: boolean
}

/** Everything the controller needs from the graph, injected so tests need no worker. */
export interface SearchSources {
    concepts(): readonly import('./index-db').ConceptCandidate[]
    searchText(query: string, offset: number, limit: number): Promise<{
        groups: SearchDocumentGroup[]
        hasMore: boolean
    }>
    searchTextCount(query: string): Promise<{ total: number; capped: boolean }>
    /** Non-null while the index is still deriving: `{ done, total }`. */
    building(): { done: number; total: number } | null
    hasEncryptedContent?(): boolean
}

export interface SearchController {
    subscribe(listener: (state: SearchState) => void): () => void
    getState(): SearchState
    /**
     * Open, optionally seeded from Quick Find. Running the search immediately is the point.
     * With no query (or an empty one) the last query is restored rather than cleared.
     */
    open(query?: string): void
    close(): void
    setQuery(query: string): void
    setNamePage(page: number): void
    setTextPage(page: number): void
    /** Re-run against a changed index (a document was edited while the modal was open). */
    refresh(): void
    dispose(): void
}

const EMPTY: SearchState = {
    open: false,
    query: '',
    nameRows: [],
    namePage: 0,
    nameTotal: 0,
    nameBuilding: false,
    textGroups: [],
    textPage: 0,
    textShownPage: 0,
    textHasMore: false,
    textCount: 0,
    textCountCapped: false,
    textStatus: { kind: 'idle' },
    hasEncryptedContent: false,
}

export function createSearchController(sources: SearchSources): SearchController {
    let state: SearchState = { ...EMPTY }
    const listeners = new Set<(state: SearchState) => void>()
    let nameTimer: ReturnType<typeof setTimeout> | undefined
    let textTimer: ReturnType<typeof setTimeout> | undefined
    /**
     * Supersedes an in-flight answer. The same guard the Backlinks View uses: without it, a
     * slow reply for an older query overwrites a newer one, and results flicker backwards.
     */
    let textToken = 0
    /**
     * The query whose results are currently on screen. A re-run for the SAME query updates in
     * place instead of blanking to the skeleton: an index change is not a reason to take away
     * results the user is reading.
     */
    let loadedQuery: string | null = null
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

    function emit() {
        for (const listener of listeners) listener(state)
    }
    function set(patch: Partial<SearchState>) {
        state = { ...state, ...patch }
        emit()
    }

    /** Names: synchronous, from the pushed snapshot. Nothing here can fail or be slow. */
    function runNames() {
        const building = sources.building()
        const all = state.query.trim() === '' ? [] : rankQuickFind(sources.concepts(), state.query)
        set({
            nameRows: all,
            nameTotal: all.length,
            nameBuilding: building !== null,
        })
    }

    function runText() {
        const token = ++textToken
        const query = state.query
        const requestedPage = state.textPage
        if (!isSearchableTextQuery(query)) {
            set({
                textGroups: [],
                textHasMore: false,
                textCount: 0,
                textCountCapped: false,
                textStatus: query.trim() === '' ? { kind: 'idle' } : { kind: 'too-short' },
            })
            return
        }
        const building = sources.building()
        if (building) {
            // Refuse, explicitly. Partial text results are worse than none: the user cannot
            // tell "not found" from "not indexed yet", and a wrong "no" to "does anything
            // mention X?" is the one failure this feature must not have.
            set({
                textGroups: [],
                textHasMore: false,
                textCount: 0,
                textCountCapped: false,
                textStatus: { kind: 'building', done: building.done, total: building.total },
            })
            return
        }
        // Only show the skeleton when there is nothing to show. Re-running for a query whose
        // results are already up means an index change, and blanking them would make a stream
        // of changes look like a search that never finishes.
        if (loadedQuery !== query || state.textGroups.length === 0) {
            set({ textStatus: { kind: 'loading' } })
        }
        void sources
            .searchText(query, requestedPage * TEXT_PAGE_SIZE, TEXT_PAGE_SIZE)
            .then((page) => {
                if (token !== textToken) return
                loadedQuery = query
                set({
                    textGroups: page.groups,
                    textShownPage: requestedPage,
                    textHasMore: page.hasMore,
                    textStatus: { kind: 'ready' },
                    hasEncryptedContent: sources.hasEncryptedContent?.() ?? false,
                })
            })
            .catch((error: unknown) => {
                if (token !== textToken) return
                set({
                    textGroups: [],
                    textHasMore: false,
                    textStatus: {
                        kind: 'failed',
                        message:
                            error instanceof Error ? error.message : 'The search could not run.',
                    },
                })
            })
        // In parallel and never awaited together: a prefix query can make the count slow, and
        // it must not hold up the rows.
        void sources
            .searchTextCount(query)
            .then((count) => {
                if (token !== textToken) return
                set({ textCount: count.total, textCountCapped: count.capped })
            })
            .catch(() => {
                if (token !== textToken) return
                set({ textCount: 0, textCountCapped: false })
            })
    }

    function schedule() {
        if (nameTimer) clearTimeout(nameTimer)
        if (textTimer) clearTimeout(textTimer)
        nameTimer = setTimeout(() => {
            nameTimer = undefined
            runNames()
        }, NAME_DEBOUNCE_MS)
        textTimer = setTimeout(() => {
            textTimer = undefined
            runText()
        }, TEXT_DEBOUNCE_MS)
    }

    return {
        subscribe(listener) {
            listeners.add(listener)
            listener(state)
            return () => listeners.delete(listener)
        },
        getState: () => state,
        open(query?: string) {
            // Reopening with nothing to say RESTORES the last query: closing on a result is
            // not abandoning the search, and starting blank would punish coming back.
            const next = query !== undefined && query.trim() !== '' ? query : state.query
            state = { ...EMPTY, open: true, query: next }
            emit()
            // Immediately, not debounced: a handoff from Quick Find that sat blank for a beat
            // reads as broken.
            runNames()
            runText()
        },
        close() {
            if (nameTimer) clearTimeout(nameTimer)
            if (textTimer) clearTimeout(textTimer)
            if (refreshTimer) clearTimeout(refreshTimer)
            nameTimer = textTimer = refreshTimer = undefined
            textToken++
            set({ open: false })
        },
        setQuery(query) {
            // Both pagers reset: paging is for after you stop typing, and a page number that
            // survived a query change would point into a different result set.
            set({ query, namePage: 0, textPage: 0 })
            schedule()
        },
        setNamePage(page) {
            set({ namePage: Math.max(0, page) })
        },
        setTextPage(page) {
            set({ textPage: Math.max(0, page) })
            runText()
        },
        refresh() {
            if (!state.open || refreshTimer) return
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined
                if (!state.open) return
                runNames()
                runText()
            }, REFRESH_THROTTLE_MS)
        },
        dispose() {
            if (nameTimer) clearTimeout(nameTimer)
            if (textTimer) clearTimeout(textTimer)
            if (refreshTimer) clearTimeout(refreshTimer)
            listeners.clear()
        },
    }
}

/** The slice of name rows the current page shows. */
export function namePageRows(state: SearchState): QuickFindRow[] {
    const from = state.namePage * NAME_PAGE_SIZE
    return state.nameRows.slice(from, from + NAME_PAGE_SIZE)
}

/** Total pages of names, at least one so the pager never reads "0 of 0". */
export function namePageCount(state: SearchState): number {
    return Math.max(1, Math.ceil(state.nameTotal / NAME_PAGE_SIZE))
}

/** A page turn the ← and → keys can make: which group, and the page it lands on. */
export interface PageTurn {
    group: 'names' | 'text'
    page: number
}

/**
 * The page turn ← (`-1`) or → (`1`) makes while the highlight is on the row at `activeIndex`,
 * or `null` when there is no page that way.
 *
 * The group is the one the highlighted row is in. Indexes run through the current page's name
 * rows first and then the text hits, the same order the modal's single selection uses, so a
 * short last page of names hands over to text sooner.
 *
 * Names are held in full, so their page count is known. Text is fetched a page at a time and
 * `textHasMore` describes the page on screen, so a forward turn waits for the page asked for
 * to land; a backward one never needs to.
 */
export function pageTurnFor(state: SearchState, activeIndex: number, step: 1 | -1): PageTurn | null {
    if (activeIndex < namePageRows(state).length) {
        const page = state.namePage + step
        if (page < 0 || page >= namePageCount(state)) return null
        return { group: 'names', page }
    }
    if (state.textStatus.kind !== 'ready' || state.textGroups.length === 0) return null
    const page = state.textPage + step
    if (page < 0) return null
    if (step > 0 && (!state.textHasMore || state.textShownPage !== state.textPage)) return null
    return { group: 'text', page }
}

/**
 * Where the highlight goes when Up (`-1`) or Down (`1`) is pressed in the Search box.
 *
 * `null` is the box itself: nothing highlighted, the caret in the field. It sits above the top
 * result, so Down from the box - wherever the caret is in the text - highlights the top result,
 * and Up from the top result goes back to the box. The bottom end clamps rather than wrapping:
 * holding Down to reach the last result and being thrown back to the top is disorienting, and
 * the list is a ranked set of answers, not a carousel.
 */
export function stepSearchHighlight(
    current: number | null,
    count: number,
    step: 1 | -1,
): number | null {
    if (count === 0) return null
    if (current === null) return step > 0 ? 0 : null
    if (step < 0) return current === 0 ? null : current - 1
    return Math.min(current + 1, count - 1)
}
