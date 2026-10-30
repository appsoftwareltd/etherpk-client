import { describe, expect, it, vi } from 'vitest'

import type { Bookmark } from '$lib/document/bookmarks/bookmarks'
import { CIPHER_FENCE_INFO } from '$lib/document/protection/fence-info'

import {
    bookmarksOnProtectedPages,
    createProtectedBookmarkSweeper,
    fencedPages,
    folderDocumentTexts,
    protectedBookmarksNotice,
    type MemberBookmarks,
} from './protected-bookmarks'

const mark = (id: string, concept: string): Bookmark => ({ id, concept, line: 0, text: 'water the beans', createdAt: 1 })

const FENCE = ['```' + CIPHER_FENCE_INFO, 'AAAA', '```'].join('\n')
/** A Protected Document as stored: frontmatter, then one cipher fence that is the whole body. */
const PROTECTED_PAGE = `---\ntitle: Garden\n---\n${FENCE}\n`
/** A page that holds a cipher fence among bullets: flagged by the index, but not a Protected Document. */
const FENCE_AMONG_BULLETS = ['- water the beans', '- pick the peas', FENCE, '- weed the rows'].join('\n')

describe('fencedPages', () => {
    it('maps every key the index flags as holding a cipher fence to the page it opens, aliases included', () => {
        const pages = fencedPages([
            { display: 'Garden', key: 'garden', kind: 'page', protected: true },
            { display: 'Kitchen', key: 'kitchen', kind: 'page' },
            { display: 'Veg Patch', key: 'veg patch', kind: 'alias', canonical: 'Garden', protected: true },
            { display: '2026-07-16', key: '2026-07-16', kind: 'journal', protected: true },
        ])
        expect([...pages].sort()).toEqual([
            ['2026-07-16', '2026-07-16'],
            ['garden', 'Garden'],
            ['veg patch', 'Garden'],
        ])
    })
})

describe('bookmarksOnProtectedPages', () => {
    it('finds the bookmarks whose page is protected, by concept identity, with each page named once', () => {
        const found = bookmarksOnProtectedPages(
            [mark('a', 'Garden'), mark('b', 'Kitchen'), mark('c', ' garden '), mark('d', 'Pantry')],
            new Set(['garden', 'pantry']),
        )
        expect(found).toEqual({ ids: ['a', 'c', 'd'], concepts: ['Garden', 'Pantry'] })
        expect(bookmarksOnProtectedPages([mark('b', 'Kitchen')], new Set(['garden']))).toEqual({ ids: [], concepts: [] })
    })
})

describe('protectedBookmarksNotice', () => {
    it('names the page when there is one, and counts the pages when there are several', () => {
        expect(protectedBookmarksNotice(1, ['Garden'])).toBe('Removed the bookmark from "Garden": a protected page keeps no bookmarks.')
        expect(protectedBookmarksNotice(3, ['Garden'])).toBe('Removed 3 bookmarks from "Garden": a protected page keeps no bookmarks.')
        expect(protectedBookmarksNotice(4, ['Garden', 'Pantry'])).toBe('Removed 4 bookmarks from 2 protected pages: a protected page keeps no bookmarks.')
    })
})

describe('folderDocumentTexts', () => {
    it('reads each page as the folder store holds it, null where it has none', async () => {
        const texts = await folderDocumentTexts({ documentText: async (target) => (target === 'Garden' ? PROTECTED_PAGE : null) })(['Garden', 'Kitchen'])
        expect([...texts]).toEqual([
            ['Garden', PROTECTED_PAGE],
            ['Kitchen', null],
        ])
    })
})

describe('createProtectedBookmarkSweeper: a protected page keeps no bookmarks, wherever it was protected (ADR 0159)', () => {
    function setup(initial: Bookmark[], fenced: Record<string, string>, texts: Record<string, string | null>, members?: MemberBookmarks) {
        let bookmarks = initial
        let fencedMap = new Map(Object.entries(fenced))
        const stored = new Map(Object.entries(texts))
        const notify = vi.fn()
        const remove = vi.fn(async (ids: readonly string[]) => {
            const gone = new Set(ids)
            bookmarks = bookmarks.filter((b) => !gone.has(b.id))
        })
        const readTexts = vi.fn(async (pages: readonly string[]) => new Map(pages.map((page) => [page, stored.get(page) ?? null])))
        const sweeper = createProtectedBookmarkSweeper({
            fencedPages: () => fencedMap,
            readTexts,
            bookmarks: () => bookmarks,
            remove,
            everyMember: members ? () => members : undefined,
            notify,
            delayMs: 10,
        })
        return {
            sweeper,
            notify,
            remove,
            readTexts,
            fence: (key: string, page: string) => (fencedMap = new Map([...fencedMap, [key, page]])),
            write: (page: string, text: string | null) => stored.set(page, text),
            add: (b: Bookmark) => (bookmarks = [...bookmarks, b]),
            list: () => bookmarks,
        }
    }

    it('removes the bookmarks on a page that reads as a Protected Document and says so once', async () => {
        const t = setup([mark('a', 'Garden'), mark('b', 'Kitchen'), mark('c', 'Garden')], { garden: 'Garden' }, { Garden: PROTECTED_PAGE })
        await t.sweeper.sweep()
        expect(t.list().map((b) => b.id)).toEqual(['b'])
        expect(t.remove).toHaveBeenCalledTimes(1)
        expect(t.notify).toHaveBeenCalledWith('Removed 2 bookmarks from "Garden": a protected page keeps no bookmarks.')
        // Nothing left to remove: no write and no second notice.
        await t.sweeper.sweep()
        expect(t.remove).toHaveBeenCalledTimes(1)
        expect(t.notify).toHaveBeenCalledTimes(1)
    })

    it('keeps a bookmark on a page that holds a cipher fence among bullets: the index flags it, but it is not a Protected Document', async () => {
        const t = setup([mark('a', 'Garden')], { garden: 'Garden' }, { Garden: FENCE_AMONG_BULLETS })
        await t.sweeper.sweep()
        expect(t.list().map((b) => b.id)).toEqual(['a'])
        expect(t.remove).not.toHaveBeenCalled()
        expect(t.notify).not.toHaveBeenCalled()
        // Read once: until the page changes, a sweep decides from what it read.
        await t.sweeper.sweep()
        expect(t.readTexts).toHaveBeenCalledTimes(1)
    })

    it('reads a page again once it changed, so a page then protected whole loses its bookmarks', async () => {
        const t = setup([mark('a', 'Garden')], { garden: 'Garden' }, { Garden: FENCE_AMONG_BULLETS })
        await t.sweeper.sweep()
        t.write('Garden', PROTECTED_PAGE)
        t.sweeper.forget('Garden')
        await t.sweeper.sweep()
        expect(t.list()).toEqual([])
        expect(t.readTexts).toHaveBeenCalledTimes(2)
    })

    it('reads nothing for a bookmark on a page the index does not flag', async () => {
        const t = setup([mark('a', 'Kitchen')], { garden: 'Garden' }, { Garden: PROTECTED_PAGE })
        await t.sweeper.sweep()
        expect(t.readTexts).not.toHaveBeenCalled()
        expect(t.list().map((b) => b.id)).toEqual(['a'])
    })

    it('keeps the bookmarks of a page whose text could not be read, and reads it again at the next sweep', async () => {
        const t = setup([mark('a', 'Garden')], { garden: 'Garden' }, { Garden: null })
        await t.sweeper.sweep()
        expect(t.list().map((b) => b.id)).toEqual(['a'])
        t.write('Garden', PROTECTED_PAGE)
        await t.sweeper.sweep()
        expect(t.list()).toEqual([])
    })

    it('finds a bookmark held under an alias of a protected page, reading the page by its own name', async () => {
        const t = setup([mark('a', 'Veg Patch')], { garden: 'Garden', 'veg patch': 'Garden' }, { Garden: PROTECTED_PAGE })
        await t.sweeper.sweep()
        expect(t.readTexts).toHaveBeenCalledWith(['Garden'])
        expect(t.list()).toEqual([])
    })

    it('removes every Member’s bookmarks on a protected page, a page only another Member bookmarked included', async () => {
        const removeOn = vi.fn()
        const members: MemberBookmarks = { concepts: () => ['Garden', 'Pantry', 'Kitchen'], removeOn }
        const t = setup([mark('a', 'Garden')], { garden: 'Garden', pantry: 'Pantry' }, { Garden: PROTECTED_PAGE, Pantry: PROTECTED_PAGE }, members)
        await t.sweeper.sweep()
        // The person's own go through the list, with the notice; everyone's go in the graph.
        expect(t.list()).toEqual([])
        expect(t.notify).toHaveBeenCalledWith('Removed the bookmark from "Garden": a protected page keeps no bookmarks.')
        expect(removeOn).toHaveBeenCalledTimes(1)
        expect([...removeOn.mock.calls[0][0]].sort()).toEqual(['garden', 'pantry'])
    })

    it('still removes every Member’s bookmarks when the person’s own removal is refused', async () => {
        const removeOn = vi.fn()
        const onError = vi.fn()
        const sweeper = createProtectedBookmarkSweeper({
            fencedPages: () => new Map([['garden', 'Garden']]),
            readTexts: async () => new Map([['Garden', PROTECTED_PAGE]]),
            bookmarks: () => [mark('a', 'Garden')],
            remove: async () => {
                throw new Error('offline')
            },
            everyMember: () => ({ concepts: () => ['Garden'], removeOn }),
            notify: vi.fn(),
            onError,
        })
        await sweeper.sweep()
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))
        expect(removeOn).toHaveBeenCalledWith(['garden'])
    })

    it('gathers a burst of scheduled sweeps into one, after the delay', async () => {
        vi.useFakeTimers()
        try {
            const t = setup([mark('a', 'Garden')], {}, { Garden: PROTECTED_PAGE })
            t.fence('garden', 'Garden')
            t.sweeper.schedule()
            t.sweeper.schedule()
            expect(t.remove).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(10)
            expect(t.remove).toHaveBeenCalledTimes(1)
            expect(t.list()).toEqual([])
        } finally {
            vi.useRealTimers()
        }
    })

    it('runs once more after a sweep in progress when asked meanwhile, so a bookmark that arrived then is not missed', async () => {
        const t = setup([mark('a', 'Garden')], { garden: 'Garden' }, { Garden: PROTECTED_PAGE })
        const removeNow = t.remove.getMockImplementation()!
        let second: Promise<void> | undefined
        t.remove.mockImplementationOnce(async (ids) => {
            await removeNow(ids)
            // A bookmark arrives from another device while the first removal is being written.
            t.add(mark('b', 'Garden'))
            second = t.sweeper.sweep()
        })
        await t.sweeper.sweep()
        await second
        expect(t.list()).toEqual([])
        expect(t.remove).toHaveBeenCalledTimes(2)
    })

    it('does not keep what it read about a page that changed while it was reading', async () => {
        const t = setup([mark('a', 'Garden')], { garden: 'Garden' }, { Garden: FENCE_AMONG_BULLETS })
        let releaseRead!: () => void
        t.readTexts.mockImplementationOnce(async (pages) => {
            await new Promise<void>((resolve) => (releaseRead = resolve))
            return new Map(pages.map((page) => [page, FENCE_AMONG_BULLETS]))
        })
        const sweeping = t.sweeper.sweep()
        await Promise.resolve()
        // The page is protected whole while the first read is out.
        t.write('Garden', PROTECTED_PAGE)
        t.sweeper.forget('Garden')
        releaseRead()
        await sweeping
        await t.sweeper.sweep()
        expect(t.list()).toEqual([])
    })

    it('reports a read that fails instead of throwing, and keeps the bookmarks until a later read', async () => {
        const onError = vi.fn()
        const remove = vi.fn(async () => {})
        let fail = true
        const sweeper = createProtectedBookmarkSweeper({
            fencedPages: () => new Map([['garden', 'Garden']]),
            readTexts: async () => {
                if (fail) throw new Error('The graph is closed.')
                return new Map([['Garden', PROTECTED_PAGE]])
            },
            bookmarks: () => [mark('a', 'Garden')],
            remove,
            notify: vi.fn(),
            onError,
        })
        await expect(sweeper.sweep()).resolves.toBeUndefined()
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'The graph is closed.' }))
        expect(remove).not.toHaveBeenCalled()
        fail = false
        await sweeper.sweep()
        expect(remove).toHaveBeenCalledWith(['a'])
    })

    it('reports a refused removal instead of throwing, and sweeps nothing after dispose', async () => {
        vi.useFakeTimers()
        try {
            const onError = vi.fn()
            const sweeper = createProtectedBookmarkSweeper({
                fencedPages: () => new Map([['garden', 'Garden']]),
                readTexts: async () => new Map([['Garden', PROTECTED_PAGE]]),
                bookmarks: () => [mark('a', 'Garden')],
                remove: async () => {
                    throw new Error('offline')
                },
                notify: vi.fn(),
                onError,
                delayMs: 10,
            })
            await sweeper.sweep()
            expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))

            sweeper.schedule()
            sweeper.dispose()
            await vi.advanceTimersByTimeAsync(20)
            expect(onError).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })
})
