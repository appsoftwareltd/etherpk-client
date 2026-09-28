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
 *
 * [[Property Filter]]s (ADR 0107) break the symmetry for names only while one is typed: the
 * documents passing a filter are a round trip too, so a filtered names group keeps its previous
 * rows until that answer lands, guarded the same way text is.
 */

import { conceptKey } from './backlinks'
import type { PropertyKeyInfo, PropertyMatch, PropertyValueInfo, SearchDocumentGroup } from './index-db'
import { rankQuickFind, type QuickFindRow } from './quick-find'
import { isSearchableTextQuery, parseSearchQuery, type PropertyFilter, type PropertyFilterTerm } from './search-query'

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
    /** Filters and no words: the names group lists the matching documents, and text has none. */
    | { kind: 'hidden' }
    | { kind: 'too-short' }
    | { kind: 'building'; done: number; total: number }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'failed'; message: string }

/** A names row, with the values that matched when Property Filters narrowed the group. */
export interface SearchNameRow extends QuickFindRow {
    properties?: { key: string; value: string }[]
}

export interface SearchState {
    open: boolean
    query: string
    /**
     * Names, already paged. Answered synchronously, so it has no loading state of its own, unless
     * a Property Filter is typed: then it is the round trip's answer, and the previous rows stay
     * until it lands.
     */
    nameRows: SearchNameRow[]
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
    /** The Property Filters recognised in the query, in order, with where each sits: the chips. */
    filterTerms: PropertyFilterTerm[]
    /**
     * The keys the graph's searchable documents carry, most used first. What makes a typed `x:y`
     * a filter, and what the key suggestions offer. Empty until the first answer lands.
     */
    propertyKeys: PropertyKeyInfo[]
}

/** Everything the controller needs from the graph, injected so tests need no worker. */
export interface SearchSources {
    concepts(): readonly import('./index-db').ConceptCandidate[]
    searchText(query: string, offset: number, limit: number, filters?: readonly PropertyFilter[]): Promise<{
        groups: SearchDocumentGroup[]
        hasMore: boolean
    }>
    searchTextCount(query: string, filters?: readonly PropertyFilter[]): Promise<{ total: number; capped: boolean }>
    /** The keys the graph uses. Absent where there is no index to ask: nothing is then a filter. */
    propertyKeys?(): Promise<readonly PropertyKeyInfo[]>
    /** The values one key has, for the value suggestions. */
    propertyValues?(key: string): Promise<readonly PropertyValueInfo[]>
    /** Every document passing the filters, with the values they matched. */
    propertyMatch?(filters: readonly PropertyFilter[]): Promise<readonly PropertyMatch[]>
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
    /** The values a key has, for the suggestion list. Asked once per key per opening. */
    propertyValues(key: string): Promise<readonly PropertyValueInfo[]>
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
    filterTerms: [],
    propertyKeys: [],
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
    /** Supersedes a filtered names answer, as `textToken` does for text. */
    let nameToken = 0
    /** The keys a typed `x:y` may name, lower-cased: filters match keys ignoring case. */
    let knownKeys: ReadonlySet<string> = new Set()
    /** Value suggestions per lower-cased key, for this opening. */
    let valueCache = new Map<string, Promise<readonly PropertyValueInfo[]>>()

    function emit() {
        for (const listener of listeners) listener(state)
    }
    function set(patch: Partial<SearchState>) {
        state = { ...state, ...patch }
        emit()
    }

    function parsed() {
        return parseSearchQuery(state.query, knownKeys)
    }

    /**
     * Names: synchronous, from the pushed snapshot, when no filter is typed. Nothing here can fail
     * or be slow. With filters it is a round trip for the documents passing them; see
     * {@link runFilteredNames}.
     */
    function runNames() {
        const building = sources.building()
        const { words, filters, terms } = parsed()
        if (filters.length > 0 && sources.propertyMatch) {
            set({ filterTerms: terms, nameBuilding: building !== null })
            runFilteredNames(words, filters)
            return
        }
        nameToken++
        const all = words.trim() === '' ? [] : rankQuickFind(sources.concepts(), words)
        set({
            nameRows: all,
            nameTotal: all.length,
            nameBuilding: building !== null,
            filterTerms: terms,
        })
    }

    /**
     * The names group narrowed to the documents passing `filters`. With words, the usual ranking
     * over just those documents' names and aliases, without the create row: a Draft carries no
     * Property. Without words, every matching document by name, each with the values it matched.
     */
    function runFilteredNames(words: string, filters: readonly PropertyFilter[]) {
        const token = ++nameToken
        void sources.propertyMatch!(filters)
            .then((documents) => {
                if (token !== nameToken) return
                const byKey = new Map(documents.map((doc) => [conceptKey(doc.concept), doc]))
                let rows: SearchNameRow[]
                if (words.trim() === '') {
                    rows = [...documents]
                        .sort((a, b) => a.concept.localeCompare(b.concept))
                        .map((doc) => ({
                            label: doc.concept,
                            target: doc.concept,
                            detail: doc.kind === 'journal' ? 'Journal' : 'Page',
                            kind: doc.kind,
                            properties: doc.properties,
                        }))
                } else {
                    const candidates = sources.concepts().filter((candidate) => {
                        if (candidate.kind === 'page' || candidate.kind === 'journal') return byKey.has(candidate.key)
                        if (candidate.kind === 'alias') return byKey.has(conceptKey(candidate.canonical ?? ''))
                        return false
                    })
                    rows = rankQuickFind(candidates, words)
                        .filter((row) => row.kind !== 'draft')
                        .map((row) => {
                            const properties = byKey.get(conceptKey(row.target))?.properties ?? []
                            return properties.length > 0 ? { ...row, properties } : row
                        })
                }
                set({ nameRows: rows, nameTotal: rows.length })
            })
            .catch(() => {
                if (token !== nameToken) return
                set({ nameRows: [], nameTotal: 0 })
            })
    }

    /**
     * Ask for the graph's keys, and re-run when they change what the query means: until they
     * land, every `x:y` is words.
     */
    function loadKeys() {
        if (!sources.propertyKeys) return
        void sources
            .propertyKeys()
            .then((keys) => {
                if (!state.open) return
                const next = new Set(keys.map((info) => info.key.toLowerCase()))
                const before = parsed()
                knownKeys = next
                set({ propertyKeys: [...keys] })
                const after = parsed()
                if (JSON.stringify(before.filters) !== JSON.stringify(after.filters) || before.words !== after.words) {
                    runNames()
                    runText()
                }
            })
            .catch(() => undefined)
    }

    function runText() {
        const token = ++textToken
        const { words: query, filters } = parsed()
        const requestedPage = state.textPage
        if (filters.length > 0 && query.trim() === '') {
            set({
                textGroups: [],
                textHasMore: false,
                textCount: 0,
                textCountCapped: false,
                textStatus: { kind: 'hidden' },
            })
            return
        }
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
        const loadedKey = `${query}\u0000${JSON.stringify(filters)}`
        if (loadedQuery !== loadedKey || state.textGroups.length === 0) {
            set({ textStatus: { kind: 'loading' } })
        }
        void sources
            .searchText(query, requestedPage * TEXT_PAGE_SIZE, TEXT_PAGE_SIZE, filters)
            .then((page) => {
                if (token !== textToken) return
                loadedQuery = loadedKey
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
            .searchTextCount(query, filters)
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
            // The keys from the last opening stand in until this one's answer lands, so a
            // restored `public:true` does not flash as words first.
            state = { ...EMPTY, open: true, query: next, propertyKeys: state.propertyKeys }
            valueCache = new Map()
            emit()
            loadKeys()
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
            nameToken++
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
                // An edit may have added or removed a key, and the cached values are stale too.
                valueCache = new Map()
                loadKeys()
                runNames()
                runText()
            }, REFRESH_THROTTLE_MS)
        },
        propertyValues(key) {
            const lower = key.toLowerCase()
            let values = valueCache.get(lower)
            if (!values) {
                values = sources.propertyValues ? sources.propertyValues(key).catch(() => []) : Promise.resolve([])
                valueCache.set(lower, values)
            }
            return values
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
export function namePageRows(state: SearchState): SearchNameRow[] {
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
