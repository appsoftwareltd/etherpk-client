import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConceptCandidate, SearchDocumentGroup } from './index-db'
import {
    createSearchController,
    namePageCount,
    namePageRows,
    NAME_PAGE_SIZE,
    pageTurnFor,
    stepSearchHighlight,
    type SearchController,
    type SearchSources,
    type SearchState,
    TEXT_PAGE_SIZE,
} from './search'

/**
 * The [[Search]] controller. The behaviour worth pinning is all about the ASYMMETRY between
 * the two groups: names are synchronous and text is a round trip, so they must not be able to
 * block, overwrite or reorder each other.
 */

function concept(display: string, kind: ConceptCandidate['kind'] = 'page'): ConceptCandidate {
    return { display, key: display.toLowerCase(), kind, ...(kind === 'pageless' ? { references: 2 } : {}) }
}

function group(concept: string, matches = 1): SearchDocumentGroup {
    return { concept, kind: 'page', matches, hits: [] }
}

function makeSources(overrides: Partial<SearchSources> = {}): SearchSources {
    return {
        concepts: () => [concept('Orphaned Assets'), concept('Orphan Sweep', 'pageless')],
        searchText: async () => ({ groups: [group('Orphaned Assets', 4)], hasMore: false }),
        searchTextCount: async () => ({ total: 1, capped: false }),
        building: () => null,
        ...overrides,
    }
}

describe('createSearchController', () => {
    let controller: SearchController
    beforeEach(() => {
        vi.useFakeTimers()
    })

    function settle() {
        vi.runAllTimers()
        return vi.waitFor(() => {})
    }

    it('runs both groups immediately on open, without waiting for a debounce', async () => {
        // A handoff from Quick Find that sat blank for a beat reads as broken.
        controller = createSearchController(makeSources())
        controller.open('orphan')

        expect(controller.getState().nameRows.length).toBeGreaterThan(0)
        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))
        expect(controller.getState().textGroups).toHaveLength(1)
    })

    it('answers names before text, because names never cross a message boundary', async () => {
        let resolveText: (v: { groups: SearchDocumentGroup[]; hasMore: boolean }) => void = () => {}
        controller = createSearchController(
            makeSources({
                searchText: () =>
                    new Promise((resolve) => {
                        resolveText = resolve
                    }),
            }),
        )
        controller.open('orphan')

        // Names are already there while text is still in flight.
        expect(controller.getState().nameRows.length).toBeGreaterThan(0)
        expect(controller.getState().textStatus.kind).toBe('loading')

        resolveText({ groups: [group('Orphaned Assets')], hasMore: false })
        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))
    })

    it('discards a slow answer that a newer query has superseded', async () => {
        // Without this guard results flicker backwards as you type.
        const pending: ((v: { groups: SearchDocumentGroup[]; hasMore: boolean }) => void)[] = []
        controller = createSearchController(
            makeSources({
                searchText: () => new Promise((resolve) => pending.push(resolve)),
            }),
        )
        controller.open('first')
        controller.setQuery('second')
        await settle()

        expect(pending).toHaveLength(2)
        // The FIRST query answers last. It must not land.
        pending[1]({ groups: [group('Second')], hasMore: false })
        pending[0]({ groups: [group('First')], hasMore: false })
        await vi.waitFor(() =>
            expect(controller.getState().textGroups.map((g) => g.concept)).toEqual(['Second']),
        )
    })

    it('refuses text results while the index is building rather than showing partial ones', async () => {
        controller = createSearchController(
            makeSources({ building: () => ({ done: 1240, total: 2838 }) }),
        )
        controller.open('orphan')

        expect(controller.getState().textStatus).toEqual({
            kind: 'building',
            done: 1240,
            total: 2838,
        })
        expect(controller.getState().textGroups).toEqual([])
        // Names still say they are partial, rather than pretending to be complete.
        expect(controller.getState().nameBuilding).toBe(true)
    })

    it('says too-short rather than searching for a single character', async () => {
        const searchText = vi.fn(async () => ({ groups: [], hasMore: false }))
        controller = createSearchController(makeSources({ searchText }))
        controller.open('o')

        expect(controller.getState().textStatus.kind).toBe('too-short')
        expect(searchText).not.toHaveBeenCalled()
        // Names run from the first character, so the modal fills in from the top.
        expect(controller.getState().nameRows.length).toBeGreaterThan(0)
    })

    it('is idle, not too-short, on an empty query', () => {
        controller = createSearchController(makeSources())
        controller.open('')
        expect(controller.getState().textStatus.kind).toBe('idle')
    })

    it('runs the count in parallel and never lets it hold up the rows', async () => {
        let resolveCount: (v: { total: number; capped: boolean }) => void = () => {}
        controller = createSearchController(
            makeSources({
                searchTextCount: () =>
                    new Promise((resolve) => {
                        resolveCount = resolve
                    }),
            }),
        )
        controller.open('orphan')

        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))
        expect(controller.getState().textGroups).toHaveLength(1)
        expect(controller.getState().textCount).toBe(0) // not in yet, and not blocking

        resolveCount({ total: 137, capped: true })
        await vi.waitFor(() => expect(controller.getState().textCount).toBe(137))
        expect(controller.getState().textCountCapped).toBe(true)
    })

    it('survives a failing text search without losing the names', async () => {
        controller = createSearchController(
            makeSources({ searchText: async () => Promise.reject(new Error('worker gone')) }),
        )
        controller.open('orphan')

        await vi.waitFor(() =>
            expect(controller.getState().textStatus).toEqual({
                kind: 'failed',
                message: 'worker gone',
            }),
        )
        expect(controller.getState().nameRows.length).toBeGreaterThan(0)
    })

    it('resets both pagers when the query changes', async () => {
        controller = createSearchController(makeSources())
        controller.open('orphan')
        controller.setNamePage(2)
        controller.setTextPage(3)
        expect(controller.getState().namePage).toBe(2)

        controller.setQuery('other')
        expect(controller.getState().namePage).toBe(0)
        expect(controller.getState().textPage).toBe(0)
    })

    it('pages text by asking the index for the next offset', async () => {
        const searchText = vi.fn(async () => ({ groups: [group('A')], hasMore: true }))
        controller = createSearchController(makeSources({ searchText }))
        controller.open('orphan')
        await settle()

        controller.setTextPage(1)
        expect(searchText).toHaveBeenLastCalledWith('orphan', TEXT_PAGE_SIZE, TEXT_PAGE_SIZE, [])
    })

    it('records which text page is on screen only once that page has landed', async () => {
        let resolveText: (v: { groups: SearchDocumentGroup[]; hasMore: boolean }) => void = () => {}
        const searchText = vi.fn(
            () =>
                new Promise<{ groups: SearchDocumentGroup[]; hasMore: boolean }>((resolve) => {
                    resolveText = resolve
                }),
        )
        controller = createSearchController(makeSources({ searchText }))
        controller.open('orphan')
        resolveText({ groups: [group('A')], hasMore: true })
        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))
        expect(controller.getState().textShownPage).toBe(0)

        controller.setTextPage(1)
        // Asked for, not yet answered: the groups on screen are still page one's.
        expect(controller.getState().textPage).toBe(1)
        expect(controller.getState().textShownPage).toBe(0)

        resolveText({ groups: [group('B')], hasMore: false })
        await vi.waitFor(() => expect(controller.getState().textShownPage).toBe(1))
    })

    it('stops listening and cancels in flight work on close', async () => {
        const searchText = vi.fn(async () => ({ groups: [group('A')], hasMore: false }))
        controller = createSearchController(makeSources({ searchText }))
        controller.open('orphan')
        controller.close()
        controller.setQuery('ignored')
        await settle()

        expect(controller.getState().open).toBe(false)
    })

    it('survives a BURST of index updates without getting stuck on the skeleton', async () => {
        // The reported bug. Opening a graph re-verifies every document, so `onUpdated` arrives
        // as a long burst. Un-throttled, every refresh bumped the token and reset the status to
        // loading, so each in-flight answer was discarded as superseded and the skeleton never
        // resolved — until the user closed and reopened the modal, which ran a fresh query.
        const resolveNext: ((v: { groups: SearchDocumentGroup[]; hasMore: boolean }) => void)[] = []
        controller = createSearchController(
            makeSources({
                searchText: () =>
                    new Promise((resolve) => {
                        resolveNext.push(resolve)
                    }),
            }),
        )
        controller.open('orphan')
        // 50 index updates arriving faster than the round trip.
        for (let i = 0; i < 50; i++) controller.refresh()
        await settle()

        // Throttled to ONE re-run, not fifty.
        expect(resolveNext.length).toBeLessThanOrEqual(2)
        resolveNext[resolveNext.length - 1]({ groups: [group('Orphaned Assets')], hasMore: false })
        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))
        expect(controller.getState().textGroups).toHaveLength(1)
    })

    it('keeps showing results while re-running for the same query', async () => {
        // An index change is not a reason to take away results the user is reading.
        let pending: ((v: { groups: SearchDocumentGroup[]; hasMore: boolean }) => void) | null = null
        controller = createSearchController(
            makeSources({
                searchText: () =>
                    pending
                        ? new Promise((resolve) => {
                              pending = resolve
                          })
                        : Promise.resolve({ groups: [group('Orphaned Assets', 4)], hasMore: false }),
            }),
        )
        controller.open('orphan')
        await vi.waitFor(() => expect(controller.getState().textStatus.kind).toBe('ready'))

        // Now make the next call hang, and refresh.
        pending = () => {}
        controller.refresh()
        await settle()

        // Still 'ready', still showing what it had — no skeleton flash.
        expect(controller.getState().textStatus.kind).toBe('ready')
        expect(controller.getState().textGroups).toHaveLength(1)
    })

    it('does show the skeleton when the query changes, because the old results are wrong', async () => {
        controller = createSearchController(
            makeSources({ searchText: () => new Promise(() => {}) }),
        )
        controller.open('orphan')
        controller.setQuery('something else')
        await settle()

        expect(controller.getState().textStatus.kind).toBe('loading')
    })

    it('stops a throttled refresh from firing after close', async () => {
        const searchText = vi.fn(async () => ({ groups: [], hasMore: false }))
        controller = createSearchController(makeSources({ searchText }))
        controller.open('orphan')
        await settle()
        const callsWhileOpen = searchText.mock.calls.length

        controller.refresh()
        controller.close()
        await settle()

        expect(searchText.mock.calls.length).toBe(callsWhileOpen)
    })

    it('reports encrypted content only once a search has actually run', async () => {
        controller = createSearchController(makeSources({ hasEncryptedContent: () => true }))
        controller.open('orphan')
        await vi.waitFor(() => expect(controller.getState().hasEncryptedContent).toBe(true))
    })
})

describe('name paging', () => {
    const rows = Array.from({ length: 20 }, (_, n) => ({
        label: `Row ${n}`,
        target: `Row ${n}`,
        detail: 'Page',
        kind: 'page' as const,
    }))

    it('pages names five at a time', () => {
        expect(NAME_PAGE_SIZE).toBe(5)
    })

    it('slices the current page and counts at least one page', () => {
        const state = { nameRows: rows, nameTotal: rows.length, namePage: 1, namesPaged: true } as never

        expect(namePageRows(state)).toHaveLength(NAME_PAGE_SIZE)
        expect(namePageRows(state)[0].label).toBe('Row 5')
        expect(namePageCount(state)).toBe(4)
        expect(namePageCount({ nameTotal: 0, nameRows: [], namePage: 0, namesPaged: true } as never)).toBe(1)
    })

    it('shows every row on one page when the names are not paged', () => {
        const state = { nameRows: rows, nameTotal: rows.length, namePage: 0, namesPaged: false } as never

        expect(namePageRows(state)).toHaveLength(20)
        expect(namePageCount(state)).toBe(1)
        expect(pageTurnFor(state, 3, 1)).toBeNull()
    })
})

describe('pageTurnFor', () => {
    /** Twelve names (three pages of five) and a page of text hits under them. */
    function paged(overrides: Partial<SearchState> = {}): SearchState {
        const nameRows = Array.from({ length: 12 }, (_, n) => ({
            label: `Row ${n}`,
            target: `Row ${n}`,
            detail: 'Page',
            kind: 'page' as const,
        }))
        const hit = { line: 0, breadcrumb: [], snippet: [] }
        return {
            ...createSearchController(makeSources()).getState(),
            open: true,
            query: 'row',
            nameRows,
            nameTotal: nameRows.length,
            textGroups: [{ ...group('A'), hits: [hit, { ...hit, line: 1 }] }],
            textStatus: { kind: 'ready' },
            textHasMore: true,
            ...overrides,
        }
    }
    /** The first text hit: every name row on the current page comes before it. */
    const FIRST_HIT = NAME_PAGE_SIZE

    it('turns the Names page when the highlight is on a name', () => {
        expect(pageTurnFor(paged(), 2, 1)).toEqual({ group: 'names', page: 1 })
        expect(pageTurnFor(paged({ namePage: 1 }), 0, -1)).toEqual({ group: 'names', page: 0 })
    })

    it('turns nothing past either end of Names', () => {
        expect(pageTurnFor(paged(), 0, -1)).toBeNull()
        expect(pageTurnFor(paged({ namePage: 2 }), 0, 1)).toBeNull()
    })

    it('turns nothing when every name fits on one page', () => {
        const few = paged({ nameRows: paged().nameRows.slice(0, 3), nameTotal: 3 })
        expect(pageTurnFor(few, 1, 1)).toBeNull()
    })

    it('turns the Text page when the highlight is on a text hit', () => {
        expect(pageTurnFor(paged(), FIRST_HIT + 1, 1)).toEqual({ group: 'text', page: 1 })
        expect(pageTurnFor(paged({ textPage: 1, textShownPage: 1 }), FIRST_HIT, -1)).toEqual({
            group: 'text',
            page: 0,
        })
    })

    it('turns nothing past either end of Text', () => {
        expect(pageTurnFor(paged(), FIRST_HIT, -1)).toBeNull()
        expect(pageTurnFor(paged({ textHasMore: false }), FIRST_HIT, 1)).toBeNull()
    })

    it('never steps past a Text page that has not landed yet', () => {
        // `textHasMore` describes the page on screen. Holding the key down would otherwise run
        // on past the last page before any answer said it was the last.
        const inFlight = paged({ textPage: 1, textShownPage: 0 })
        expect(pageTurnFor(inFlight, FIRST_HIT, 1)).toBeNull()
        // Back is always known to exist.
        expect(pageTurnFor(inFlight, FIRST_HIT, -1)).toEqual({ group: 'text', page: 0 })
    })

    it('measures Names by the rows on the current page, so a short last page hands over sooner', () => {
        // Page three holds two names (10 and 11), so index 2 is already the first text hit.
        const lastPage = paged({ namePage: 2, textPage: 1, textShownPage: 1 })
        expect(pageTurnFor(lastPage, 2, -1)).toEqual({ group: 'text', page: 0 })
    })
})

describe('stepSearchHighlight', () => {
    // `null` is the search box itself: no result highlighted, the caret in the field.
    it('goes from the box to the top result with Down, wherever the caret is', () => {
        expect(stepSearchHighlight(null, 5, 1)).toBe(0)
    })

    it('moves one result at a time', () => {
        expect(stepSearchHighlight(0, 5, 1)).toBe(1)
        expect(stepSearchHighlight(3, 5, -1)).toBe(2)
    })

    it('stops at the last result rather than wrapping to the top', () => {
        expect(stepSearchHighlight(4, 5, 1)).toBe(4)
    })

    it('goes back to the box with Up from the top result, and stays there', () => {
        expect(stepSearchHighlight(0, 5, -1)).toBeNull()
        expect(stepSearchHighlight(null, 5, -1)).toBeNull()
    })

    it('stays in the box when there is nothing to highlight', () => {
        expect(stepSearchHighlight(null, 0, 1)).toBeNull()
    })
})

describe('Property Filters (ADR 0107)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    const keys = [
        { key: 'public', documents: 2 },
        { key: 'status', documents: 1 },
    ]
    const matches = [
        { concept: 'Recipes', kind: 'page' as const, properties: [{ key: 'public', value: 'true' }] },
        { concept: 'Launch Plan', kind: 'page' as const, properties: [{ key: 'public', value: 'true' }] },
    ]

    function filterSources(overrides: Partial<SearchSources> = {}): SearchSources {
        return makeSources({
            concepts: () => [concept('Launch Plan'), concept('Recipes'), concept('Meeting Notes'), concept('Go Live', 'alias')].map((c) =>
                c.kind === 'alias' ? { ...c, canonical: 'Launch Plan' } : c,
            ),
            propertyKeys: async () => keys,
            propertyMatch: async () => matches,
            ...overrides,
        })
    }

    it('reads x:y as words until the graph’s keys have arrived, then as a filter', async () => {
        const searchText = vi.fn(async () => ({ groups: [], hasMore: false }))
        let resolveKeys: (value: typeof keys) => void = () => {}
        const controller = createSearchController(
            filterSources({
                searchText,
                propertyKeys: () => new Promise((resolve) => (resolveKeys = resolve)),
            }),
        )
        controller.open('public:true meeting')
        expect(controller.getState().filterTerms).toEqual([])
        expect(searchText).toHaveBeenLastCalledWith('public:true meeting', 0, TEXT_PAGE_SIZE, [])

        resolveKeys(keys)
        await vi.waitFor(() => expect(controller.getState().filterTerms).toHaveLength(1))
        await vi.waitFor(() =>
            expect(searchText).toHaveBeenLastCalledWith('meeting', 0, TEXT_PAGE_SIZE, [{ key: 'public', value: 'true', prefix: false, negated: false }]),
        )
    })

    it('narrows the names to documents that pass the filters, an alias row included', async () => {
        const controller = createSearchController(filterSources())
        controller.open('public:true l')
        await vi.waitFor(() => expect(controller.getState().filterTerms).toHaveLength(1))
        await vi.waitFor(() => expect(controller.getState().nameRows.map((row) => row.label)).toEqual(['Launch Plan', 'Go Live']))
        // No create row: a Draft cannot carry a Property.
        expect(controller.getState().nameRows.some((row) => row.kind === 'draft')).toBe(false)
    })

    it('with filters and no words, lists every matching document by name with its values, and hides text', async () => {
        const searchText = vi.fn(async () => ({ groups: [], hasMore: false }))
        const controller = createSearchController(filterSources({ searchText }))
        controller.open('public:true')
        await vi.waitFor(() => expect(controller.getState().nameRows.map((row) => row.label)).toEqual(['Launch Plan', 'Recipes']))
        expect(controller.getState().nameRows[0].properties).toEqual([{ key: 'public', value: 'true' }])
        expect(controller.getState().nameTotal).toBe(2)
        expect(controller.getState().textStatus.kind).toBe('hidden')
        expect(searchText).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.arrayContaining([expect.anything()]))
    })

    /** Twenty documents that all pass `public:true`, each a page of its own. */
    const many = Array.from({ length: 20 }, (_, n) => ({
        concept: `Doc ${String(n + 1).padStart(2, '0')}`,
        kind: 'page' as const,
        properties: [{ key: 'public', value: 'true' }],
    }))
    const manySources = () =>
        filterSources({ concepts: () => many.map((doc) => concept(doc.concept)), propertyMatch: async () => many })

    it('with filters and no words, lists every matching document on one page, to scroll rather than page', async () => {
        // Names is paged so it cannot push the Text group down; with no words there is no Text
        // group, and the list of documents is the whole answer.
        const controller = createSearchController(manySources())
        controller.open('public:true')
        await vi.waitFor(() => expect(controller.getState().nameTotal).toBe(20))
        const state = controller.getState()
        expect(namePageRows(state)).toHaveLength(20)
        expect(namePageCount(state)).toBe(1)
        expect(pageTurnFor(state, 10, 1)).toBeNull()
    })

    it('with filters and words, pages the names as a text search does', async () => {
        const controller = createSearchController(manySources())
        controller.open('public:true doc')
        // Ranked names stop at Quick Find's limit (twelve), which is still more than a page.
        await vi.waitFor(() => expect(controller.getState().nameTotal).toBeGreaterThan(NAME_PAGE_SIZE))
        const state = controller.getState()
        expect(namePageRows(state)).toHaveLength(NAME_PAGE_SIZE)
        expect(namePageCount(state)).toBe(3)
    })

    it('keeps the names on screen until a filtered answer lands, and drops a superseded one', async () => {
        const answers: ((value: typeof matches) => void)[] = []
        const controller = createSearchController(
            filterSources({
                propertyMatch: () => new Promise((resolve) => answers.push(resolve)),
            }),
        )
        controller.open('public:true')
        await vi.waitFor(() => expect(answers).toHaveLength(1))
        controller.setQuery('status:done')
        vi.runAllTimers()
        await vi.waitFor(() => expect(answers).toHaveLength(2))
        answers[1]([matches[0]])
        await vi.waitFor(() => expect(controller.getState().nameRows.map((row) => row.label)).toEqual(['Recipes']))
        answers[0](matches)
        await Promise.resolve()
        expect(controller.getState().nameRows.map((row) => row.label)).toEqual(['Recipes'])
    })

    it('hands out the keys it knows for the suggestion list', async () => {
        const controller = createSearchController(filterSources())
        controller.open('')
        await vi.waitFor(() => expect(controller.getState().propertyKeys).toEqual(keys))
    })
})
