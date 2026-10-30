import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    addBookmark,
    adoptBookmarks,
    BookmarksClosedError,
    bookmarksIn,
    getBookmarks,
    MAX_BOOKMARKS,
    removeAllBookmarks,
    removeBookmarks,
    removeBookmarksForUndo,
    renameBookmarkConcept,
    resetBookmarks,
    restoreBookmarks,
    sameConcept,
    sanitizeBookmarks,
    setBookmarkLabel,
    unionBookmarks,
    setBookmarks,
    subscribeBookmarks,
    updateBookmarkAnchors,
    type Bookmark,
    type BookmarksChange,
    type BookmarksPersist,
} from './bookmarks'

const anchor = { line: 2, text: 'water the beans', before: 'Garden' }

function bookmark(id: string, concept = 'Garden', line = 2): Bookmark {
    return { id, concept, line, text: `line ${id}`, createdAt: 1 }
}

afterEach(() => resetBookmarks())

describe('the bookmark list', () => {
    it('adds a bookmark with an id, its concept and its anchor, and persists only the change', async () => {
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([], persist)
        const added = await addBookmark('Garden', anchor)
        expect(added).toMatchObject({ concept: 'Garden', ...anchor })
        expect(added.id).toMatch(/\S/)
        expect(getBookmarks()).toEqual([added])
        expect(persist).toHaveBeenCalledWith({ put: [added], remove: [] }, [added])
    })

    it('rolls the list back when the backend refuses a write', async () => {
        setBookmarks([bookmark('a')], () => Promise.reject(new Error('offline')))
        await expect(removeBookmarks(['a'])).rejects.toThrow('offline')
        expect(getBookmarks().map((b) => b.id)).toEqual(['a'])
    })

    it('tells subscribers the current list at once and after each change', async () => {
        setBookmarks([bookmark('a')], null)
        const seen: string[][] = []
        const stop = subscribeBookmarks((list) => seen.push(list.map((b) => b.id)))
        await removeBookmarks(['a'])
        stop()
        expect(seen).toEqual([['a'], []])
    })

    it('lists the bookmarks of one document, case-insensitively, in line order', () => {
        setBookmarks([bookmark('a', 'Garden', 9), bookmark('b', 'Kitchen'), bookmark('c', 'garden', 1)], null)
        expect(bookmarksIn('GARDEN').map((b) => b.id)).toEqual(['c', 'a'])
    })

    it('removes all and gives back what it removed, which restore puts back', async () => {
        setBookmarks([bookmark('a'), bookmark('b')], null)
        const removed = await removeAllBookmarks()
        expect(getBookmarks()).toEqual([])
        await restoreBookmarks(removed)
        expect(getBookmarks().map((b) => b.id)).toEqual(['a', 'b'])
    })

    it('restores nothing twice', async () => {
        setBookmarks([bookmark('a')], null)
        await restoreBookmarks([bookmark('a')])
        expect(getBookmarks()).toHaveLength(1)
    })

    it('sets and clears a label, trimming it', async () => {
        setBookmarks([bookmark('a')], null)
        await setBookmarkLabel('a', '  Start here ')
        expect(getBookmarks()[0].label).toBe('Start here')
        await setBookmarkLabel('a', '   ')
        expect(getBookmarks()[0]).not.toHaveProperty('label')
    })

    it('writes an anchor back only when it changed', async () => {
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([{ ...bookmark('a'), ...anchor }], persist)
        await updateBookmarkAnchors([{ id: 'a', anchor }])
        expect(persist).not.toHaveBeenCalled()
        await updateBookmarkAnchors([{ id: 'a', anchor: { ...anchor, line: 5 } }])
        expect(persist).toHaveBeenCalledTimes(1)
        expect(getBookmarks()[0].line).toBe(5)
    })

    it('follows a rename of its document', async () => {
        setBookmarks([bookmark('a', 'Garden'), bookmark('b', 'Kitchen')], null)
        await renameBookmarkConcept('garden', 'Allotment')
        expect(getBookmarks().map((b) => b.concept)).toEqual(['Allotment', 'Kitchen'])
    })

    it('adopts a list that arrived from elsewhere without persisting it', () => {
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([], persist)
        adoptBookmarks([bookmark('a')])
        expect(getBookmarks()).toHaveLength(1)
        expect(persist).not.toHaveBeenCalled()
    })
})

describe('sanitizeBookmarks', () => {
    it('keeps well-formed entries and drops the rest', () => {
        const good = { ...bookmark('a'), before: 'x', label: 'Start' }
        expect(
            sanitizeBookmarks([good, { id: 'b' }, null, { ...bookmark('c'), text: '' }, { ...bookmark('d'), line: -1 }]),
        ).toEqual([good])
    })

    it('drops a duplicate id and anything that is not a list', () => {
        expect(sanitizeBookmarks([bookmark('a'), bookmark('a')])).toHaveLength(1)
        expect(sanitizeBookmarks({ a: 1 })).toEqual([])
    })
})

describe('unionBookmarks', () => {
    it('adds the incoming bookmarks whose id is not held, keeping the held copy of one that is', () => {
        const held = { ...bookmark('a'), label: 'Mine' }
        const incoming = [{ ...bookmark('a'), label: 'Theirs' }, bookmark('b', 'Kitchen')]
        expect(unionBookmarks([held], incoming)).toEqual([held, bookmark('b', 'Kitchen')])
    })

    it('adds nothing when the same list arrives twice', () => {
        const once = unionBookmarks([], [bookmark('a'), bookmark('b')])
        expect(unionBookmarks(once, [bookmark('a'), bookmark('b')])).toEqual(once)
    })
})

describe('writes', () => {
    it('writes one change at a time, and a failed one takes back only itself', async () => {
        const written: string[][] = []
        let failFirst: (err: Error) => void = () => {}
        const persist = vi.fn<BookmarksPersist>((_change, next) => {
            if (persist.mock.calls.length === 1) return new Promise<void>((_resolve, reject) => (failFirst = reject))
            written.push(next.map((b) => b.id))
            return Promise.resolve()
        })
        setBookmarks([], persist)
        const first = addBookmark('Garden', { line: 0, text: 'water the beans' })
        const second = addBookmark('Kitchen', { line: 0, text: 'wash the pans' })
        // The second write waits for the first.
        await Promise.resolve()
        expect(persist).toHaveBeenCalledTimes(1)
        failFirst(new Error('offline'))
        await expect(first).rejects.toThrow('offline')
        const kept = await second
        // What reached the backend and what is on screen agree: only the second bookmark.
        expect(written).toEqual([[kept.id]])
        expect(getBookmarks().map((b) => b.id)).toEqual([kept.id])
    })

    it('puts back the earlier copy of a bookmark whose label change failed', async () => {
        setBookmarks([{ ...bookmark('a'), label: 'Old' }], () => Promise.reject(new Error('offline')))
        await expect(setBookmarkLabel('a', 'New')).rejects.toThrow('offline')
        expect(getBookmarks()[0].label).toBe('Old')
    })

    it('refuses a bookmark past the limit, saying so, rather than dropping the oldest', async () => {
        setBookmarks(
            Array.from({ length: MAX_BOOKMARKS }, (_, i) => bookmark(`b${i}`)),
            null,
        )
        await expect(addBookmark('Garden', anchor)).rejects.toThrow(/1000 bookmarks/)
        expect(getBookmarks()).toHaveLength(MAX_BOOKMARKS)
    })

    it('compares concepts as the graph does, ignoring case and surrounding spaces', () => {
        expect(sameConcept(' Garden ', 'garden')).toBe(true)
        expect(sameConcept('Garden', 'Kitchen')).toBe(false)
    })
})

/** A persist that holds each write until the test releases it, recording what it was given. */
function heldPersist() {
    const writes: { change: BookmarksChange; next: string[] }[] = []
    const pending: { resolve: () => void; reject: (err: Error) => void }[] = []
    const persist: BookmarksPersist = (change, next) =>
        new Promise<void>((resolve, reject) => {
            writes.push({ change, next: next.map((b) => b.id) })
            pending.push({ resolve, reject })
        })
    return { persist, writes, release: () => pending.shift()?.resolve(), refuse: (err: Error) => pending.shift()?.reject(err) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a graph switch: every write is bound to the graph it was made in', () => {
    it('saves a write still queued for one graph to that graph, and never to the next one', async () => {
        const a = heldPersist()
        setBookmarks([], a.persist)
        const first = addBookmark('Garden', { line: 0, text: 'water the beans' })
        const second = addBookmark('Garden', { line: 1, text: 'pick the peas' })
        await tick()
        // The graph switches while the first write is in flight and the second waits behind it.
        resetBookmarks()
        const b = vi.fn<BookmarksPersist>().mockResolvedValue()
        const held = bookmark('b-own', 'Kitchen', 0)
        setBookmarks([held], b)

        a.release()
        await first
        await tick()
        a.release()
        await second
        // Both writes reached the graph they were made in, each over that graph's own list.
        expect(a.writes.map((w) => w.next)).toEqual([[(await first).id], [(await first).id, (await second).id]])
        expect(b).not.toHaveBeenCalled()
        expect(getBookmarks()).toEqual([held])

        // A later write in the next graph is made over that graph's list alone.
        const added = await addBookmark('Kitchen', { line: 2, text: 'bake bread' })
        expect(b).toHaveBeenCalledTimes(1)
        expect(b.mock.calls[0][1].map((x) => x.id)).toEqual(['b-own', added.id])
    })

    it('does not roll the next graph’s list back when a write made in the previous graph is refused', async () => {
        const a = heldPersist()
        setBookmarks([bookmark('a1')], a.persist)
        const removal = removeBookmarks(['a1'])
        await tick()
        resetBookmarks()
        setBookmarks([bookmark('b1', 'Kitchen')], null)
        a.refuse(new Error('offline'))
        await expect(removal).rejects.toThrow('offline')
        expect(getBookmarks().map((b) => b.id)).toEqual(['b1'])
    })

    it('ignores a list adopted through a graph that has closed', () => {
        const a = setBookmarks([bookmark('a1')], null)
        resetBookmarks()
        setBookmarks([bookmark('b1', 'Kitchen')], null)
        a.adopt([bookmark('a1'), bookmark('a2')])
        expect(getBookmarks().map((b) => b.id)).toEqual(['b1'])
    })

    it('restores what an Undo returned only into the graph it was removed from', async () => {
        setBookmarks([bookmark('a1')], null)
        const { removed, restore } = await removeBookmarksForUndo(['a1'])
        expect(removed.map((b) => b.id)).toEqual(['a1'])
        resetBookmarks()
        const b = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([], b)
        await expect(restore()).rejects.toBeInstanceOf(BookmarksClosedError)
        expect(b).not.toHaveBeenCalled()
        expect(getBookmarks()).toEqual([])
    })
})

describe('closing a graph', () => {
    it('saves the write-back made just before the close to that graph, rather than resolving having saved nothing', async () => {
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([{ ...bookmark('a1'), text: 'water the beans' }], persist)
        // An editor's destroy writes back where its bookmarks are; the close follows in the same task.
        const pending = updateBookmarkAnchors([{ id: 'a1', anchor: { line: 3, text: 'water the bean rows' } }])
        resetBookmarks()
        await pending
        expect(persist).toHaveBeenCalledTimes(1)
        expect(persist.mock.calls[0][0].put).toEqual([expect.objectContaining({ id: 'a1', line: 3, text: 'water the bean rows' })])
    })

    it('refuses a write made once no graph is open, saying why, rather than keeping it nowhere', async () => {
        setBookmarks([bookmark('a1')], null)
        resetBookmarks()
        await expect(addBookmark('Garden', anchor)).rejects.toBeInstanceOf(BookmarksClosedError)
        await expect(updateBookmarkAnchors([{ id: 'a1', anchor }])).rejects.toBeInstanceOf(BookmarksClosedError)
        await expect(removeBookmarks(['a1'])).rejects.toBeInstanceOf(BookmarksClosedError)
        await expect(setBookmarkLabel('a1', 'Start')).rejects.toBeInstanceOf(BookmarksClosedError)
        await expect(renameBookmarkConcept('Garden', 'Allotment')).rejects.toBeInstanceOf(BookmarksClosedError)
        expect(getBookmarks()).toEqual([])
    })

    it('empties the list at once and resolves once the writes made before it are saved', async () => {
        const a = heldPersist()
        const graph = setBookmarks([], a.persist)
        const added = addBookmark('Garden', { line: 0, text: 'water the beans' })
        await tick()
        let closed = false
        const closing = graph.close(10_000).then(() => (closed = true))
        expect(getBookmarks()).toEqual([])
        await tick()
        expect(closed).toBe(false)
        a.release()
        await closing
        await added
        expect(a.writes).toHaveLength(1)
    })

    it('closes only its own graph’s list: a close that comes after the next graph opened leaves that list alone', async () => {
        const a = vi.fn<BookmarksPersist>().mockResolvedValue()
        const first = setBookmarks([bookmark('a1')], a)
        setBookmarks([bookmark('b1', 'Kitchen')], null)
        await first.close()
        expect(getBookmarks().map((b) => b.id)).toEqual(['b1'])
        await addBookmark('Kitchen', { line: 1, text: 'bake bread' })
        expect(getBookmarks()).toHaveLength(2)
        expect(a).not.toHaveBeenCalled()
    })

    it('stops waiting after the bound, and then refuses a write still queued rather than saving it after the graph closed', async () => {
        vi.useFakeTimers()
        try {
            const a = heldPersist()
            const graph = setBookmarks([], a.persist)
            const first = addBookmark('Garden', { line: 0, text: 'water the beans' })
            const second = addBookmark('Kitchen', { line: 0, text: 'wash the pans' })
            const secondOutcome = second.then(
                () => 'saved',
                (err: unknown) => err,
            )
            await vi.advanceTimersByTimeAsync(0)
            const closing = graph.close(500)
            await vi.advanceTimersByTimeAsync(500)
            await closing
            // The first write was still in flight: it finishes as its persist says.
            a.release()
            await first
            expect(await secondOutcome).toBeInstanceOf(BookmarksClosedError)
            expect(a.writes).toHaveLength(1)
        } finally {
            vi.useRealTimers()
        }
    })
})
