import { afterEach, describe, expect, it, vi } from 'vitest'

import { dismissNotice, getNotices } from '$lib/activity/notices'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '../../surface'
import { getBookmarks, resetBookmarks, setBookmarks, type Bookmark } from '../bookmarks/bookmarks'
import { pendingBookmarkReveal, resetBookmarkStatus } from '../bookmarks/status'
import {
    BOOKMARK_OPEN,
    BOOKMARK_REMOVE,
    BOOKMARK_REMOVE_ALL,
    BOOKMARK_REMOVE_GROUP,
    registerBookmarkCommands,
} from './bookmark-commands'

const bookmark = (id: string, concept = 'Garden'): Bookmark => ({ id, concept, line: 0, text: `line ${id}`, createdAt: 1 })

function setup() {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const deps = { openDocumentAtLine: vi.fn(), revealSidebar: vi.fn(), onError: vi.fn() }
    registerBookmarkCommands(commands, contributions, deps)
    return { commands, contributions, deps }
}

const undoOfLastNotice = () => getNotices().at(-1)?.actions?.find((a) => a.label === 'Undo')

afterEach(() => {
    resetBookmarks()
    resetBookmarkStatus()
    for (const notice of getNotices()) dismissNotice(notice.id)
})

describe('bookmark Commands', () => {
    it('removes all with an Undo that puts every one back', async () => {
        const { commands } = setup()
        setBookmarks([bookmark('a'), bookmark('b', 'Kitchen')], null)
        await commands.execute(BOOKMARK_REMOVE_ALL)
        expect(getBookmarks()).toEqual([])
        expect(getNotices().at(-1)?.text).toBe('Removed 2 bookmarks')
        await undoOfLastNotice()!.run()
        expect(getBookmarks().map((b) => b.id).sort()).toEqual(['a', 'b'])
    })

    it('removes the bookmarks of one document only', async () => {
        const { commands } = setup()
        setBookmarks([bookmark('a'), bookmark('b', 'Kitchen'), bookmark('c')], null)
        await commands.execute(BOOKMARK_REMOVE_GROUP, { kind: 'bookmark-group', concept: 'garden' })
        expect(getBookmarks().map((b) => b.id)).toEqual(['b'])
    })

    it('removes one from its Sidebar row', async () => {
        const { commands } = setup()
        setBookmarks([bookmark('a'), bookmark('b')], null)
        await commands.execute(BOOKMARK_REMOVE, { kind: 'bookmark', id: 'a' })
        expect(getBookmarks().map((b) => b.id)).toEqual(['b'])
        expect(undoOfLastNotice()).toBeDefined()
    })

    it('opens a bookmark by asking for its line before opening its document', async () => {
        const { commands, deps } = setup()
        setBookmarks([bookmark('a', 'Kitchen')], null)
        await commands.execute(BOOKMARK_OPEN, { kind: 'bookmark', id: 'a' })
        expect(pendingBookmarkReveal()).toEqual({ id: 'a', concept: 'Kitchen' })
        expect(deps.openDocumentAtLine).toHaveBeenCalledWith('Kitchen', 0)
    })

    it('offers a Sidebar row Edit label… and Remove bookmark, and a group Remove these bookmarks', () => {
        const { contributions } = setup()
        const labels = (target: object) =>
            listContextMenuItems(contributions, target as never).map((i) => i.label)
        expect(labels({ kind: 'bookmark', id: 'a' })).toEqual(['Edit label…', 'Remove bookmark'])
        expect(labels({ kind: 'bookmark-group', concept: 'Garden' })).toEqual(['Remove these bookmarks'])
    })

    it('offers Bookmark line on a line no editor is showing any more', () => {
        const { contributions } = setup()
        const target = { kind: 'line', concept: 'Garden', line: 1 }
        const labels = listContextMenuItems(contributions, target as never).map((i) => i.label)
        expect(labels).toEqual(['Bookmark line'])
    })

    it('puts a removed bookmark back with its label, from a row and from a group', async () => {
        const { commands } = setup()
        setBookmarks([{ ...bookmark('a'), label: 'Start here' }, bookmark('b'), bookmark('c', 'Kitchen')], null)
        await commands.execute(BOOKMARK_REMOVE, { kind: 'bookmark', id: 'a' })
        await undoOfLastNotice()!.run()
        expect(getBookmarks().find((b) => b.id === 'a')?.label).toBe('Start here')

        await commands.execute(BOOKMARK_REMOVE_GROUP, { kind: 'bookmark-group', concept: 'Garden' })
        expect(getBookmarks().map((b) => b.id)).toEqual(['c'])
        await undoOfLastNotice()!.run()
        expect(getBookmarks().map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
    })

    it('reports a refused removal and keeps the bookmark', async () => {
        const { commands, deps } = setup()
        setBookmarks([bookmark('a')], () => Promise.reject(new Error('The disk is full.')))
        await commands.execute(BOOKMARK_REMOVE, { kind: 'bookmark', id: 'a' })
        expect(deps.onError).toHaveBeenCalledWith('The disk is full.')
        expect(getBookmarks().map((b) => b.id)).toEqual(['a'])
    })
})
