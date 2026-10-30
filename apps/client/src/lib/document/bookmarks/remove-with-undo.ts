/**
 * Removing [[Bookmark]]s, said in a notice with an Undo that puts every one back as it was, label
 * included. One path for every surface that removes: the editor's padding, Ctrl+Alt+K, the line
 * menu, a Sidebar row, a group and Remove all. The list can be restored exactly, so no removal asks
 * first.
 */

import { type NoticeAction, showNotice } from '$lib/activity/notices'

import { BookmarksClosedError, removeBookmarksForUndo, type Bookmark } from './bookmarks'

/**
 * The removal notice and its Undo. The workspace takes it down when the graph closes, so its Undo is
 * never offered over another graph; the restore behind it refuses after a close all the same.
 */
export const BOOKMARK_NOTICE_ID = 'bookmarks'

/**
 * Remove the bookmarks with these ids and say so, with Undo. `describe` words the notice from how
 * many went. Resolves to the bookmarks removed (none when no id was in the list). A refused write
 * rejects and removes nothing; a refused Undo leaves its notice so Undo can be tried again. Undo
 * puts them back only into the graph they were removed from.
 */
export async function removeBookmarksWithUndo(
    ids: readonly string[],
    describe: (count: number) => string,
): Promise<Bookmark[]> {
    const { removed, restore } = await removeBookmarksForUndo(ids)
    if (removed.length === 0) return []
    const undo = async () => {
        try {
            await restore()
        } catch (err) {
            if (err instanceof BookmarksClosedError) {
                // Their graph has closed. Nowhere else is theirs, so no Undo is offered again.
                showNotice({
                    id: BOOKMARK_NOTICE_ID,
                    tone: 'info',
                    text: 'The bookmarks were not put back: the graph they were removed from is closed.',
                })
                return
            }
            showNotice({
                id: BOOKMARK_NOTICE_ID,
                tone: 'error',
                text: `The bookmarks could not be put back. ${reason(err)} Try Undo again.`,
                actions: [undoAction(undo)],
            })
            return
        }
        showNotice({
            id: BOOKMARK_NOTICE_ID,
            tone: 'info',
            text: removed.length === 1 ? 'Bookmark restored' : `${removed.length} bookmarks restored`,
        })
    }
    showNotice({ id: BOOKMARK_NOTICE_ID, tone: 'info', text: describe(removed.length), actions: [undoAction(undo)] })
    return removed
}

function undoAction(run: () => Promise<void>): NoticeAction {
    return { id: 'bookmark-undo', label: 'Undo', primary: true, run }
}

/** An error's message as the end of a sentence, or nothing. */
export function reason(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err ?? '')
    return message.trim() === '' ? '' : message.trim().replace(/([^.!?])$/, '$1.')
}

/** "1 bookmark", "3 bookmarks". */
export function bookmarkCount(count: number): string {
    return `${count} ${count === 1 ? 'bookmark' : 'bookmarks'}`
}
