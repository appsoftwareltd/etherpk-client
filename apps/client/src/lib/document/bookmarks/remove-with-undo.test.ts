import { afterEach, describe, expect, it, vi } from 'vitest'

import { dismissNotice, getNotices } from '$lib/activity/notices'

import { getBookmarks, resetBookmarks, setBookmarks, type Bookmark, type BookmarksPersist } from './bookmarks'
import { BOOKMARK_NOTICE_ID, removeBookmarksWithUndo } from './remove-with-undo'

const garden: Bookmark = { id: 'a1', concept: 'Garden', line: 0, text: 'water the beans', label: 'Beans', createdAt: 1 }

const undoOfNotice = () => getNotices().find((n) => n.id === BOOKMARK_NOTICE_ID)?.actions?.find((a) => a.label === 'Undo')

afterEach(() => {
    resetBookmarks()
    for (const notice of getNotices()) dismissNotice(notice.id)
})

describe('removeBookmarksWithUndo', () => {
    it('says what it removed, and Undo puts every one back as it was', async () => {
        setBookmarks([garden], null)
        expect(await removeBookmarksWithUndo(['a1'], () => 'Bookmark removed')).toEqual([garden])
        expect(getBookmarks()).toEqual([])
        expect(getNotices().find((n) => n.id === BOOKMARK_NOTICE_ID)?.text).toBe('Bookmark removed')

        await undoOfNotice()!.run()
        expect(getBookmarks()).toEqual([garden])
        expect(getNotices().find((n) => n.id === BOOKMARK_NOTICE_ID)?.text).toBe('Bookmark restored')
    })

    it('never restores into another graph: Undo run after a graph switch writes nothing to the next graph', async () => {
        setBookmarks([garden], null)
        await removeBookmarksWithUndo(['a1'], () => 'Bookmark removed')
        const undo = undoOfNotice()
        expect(undo).toBeDefined()

        // The graph closes and another opens.
        resetBookmarks()
        const next = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([], next)
        await undo!.run()

        expect(next).not.toHaveBeenCalled()
        expect(getBookmarks()).toEqual([])
        // Said, without an Undo to try again: there is nowhere it could put them back now.
        const notice = getNotices().find((n) => n.id === BOOKMARK_NOTICE_ID)
        expect(notice?.text).toBe('The bookmarks were not put back: the graph they were removed from is closed.')
        expect(notice?.actions ?? []).toEqual([])
    })
})
