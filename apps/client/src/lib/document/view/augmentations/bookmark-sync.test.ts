/**
 * The editor's side of the bookmark list (bookmarks.ts `BookmarkSync`): placing, writing back,
 * Undo's restores, a refused write and a request to show a line, driven through a stand-in for the
 * DOM view with fake timers.
 */

import { EditorState, type StateEffect, type TransactionSpec } from '@codemirror/state'
import { type DecorationSet, EditorView, type ViewUpdate } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissNotice, getNotices } from '$lib/activity/notices'

import { captureAnchor } from '../../bookmarks/anchor'
import { getBookmarks, resetBookmarks, setBookmarkLabel, setBookmarks, type Bookmark, type BookmarksPersist } from '../../bookmarks/bookmarks'
import { BOOKMARK_NOTICE_ID } from '../../bookmarks/remove-with-undo'
import { BOOKMARK_STATUS_NOTICE_ID, missingBookmarkLines, pendingBookmarkReveal, requestBookmarkReveal, resetBookmarkStatus } from '../../bookmarks/status'
import { EXTERNAL } from '../cm-document'
import { editorDocument } from '../editor-document'
import { bookmarkedLines } from './bookmark-marks'
import { BookmarkSync, bookmarksAugmentation, toggleBookmarkAtLine, WRITE_BACK_DELAY_MS, type BookmarkOptions } from './bookmarks'
import { isProtectedDocumentFacet } from './protected-document'

const NOTES = '- water the beans\n- dig the bed\n- feed the hens'

function bookmarkOn(text: string, line: number, id = 'b1', extra: Partial<Bookmark> = {}): Bookmark {
    return { id, concept: 'Garden', createdAt: 1, ...captureAnchor(text.split('\n'), line - 1)!, ...extra }
}

/** Every editor a test opened, closed after it so none answers the next test's list. */
const open: BookmarkSync[] = []

/** An editor over `doc` as the plugin sees one: its state, dispatch and focus. */
function editorOver(doc: string, options: { protectedDoc?: boolean; concept?: string; panelId?: string; bookmarks?: BookmarkOptions } = {}) {
    let state = EditorState.create({
        doc,
        extensions: [
            editorDocument.of({ concept: options.concept ?? 'Garden', panelId: options.panelId }),
            bookmarksAugmentation(options.bookmarks),
            isProtectedDocumentFacet.of(() => options.protectedDoc ?? false),
        ],
    })
    const dispatches: TransactionSpec[][] = []
    const host = {
        get state() {
            return state
        },
        dispatch(...specs: TransactionSpec[]) {
            dispatches.push(specs)
            const tr = state.update(...specs)
            const startState = state
            state = tr.state
            sync.update({ state, startState, docChanged: tr.docChanged, transactions: [tr] } as unknown as ViewUpdate)
        },
        focus: vi.fn(),
    }
    const sync = new BookmarkSync(host as never)
    open.push(sync)
    return { host, sync, dispatches }
}

/** Let queued microtasks (the plugin's deferred writes and syncs) and due timers run. */
async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms)
    for (let i = 0; i < 5; i++) await Promise.resolve()
}

const markedTexts = (host: { state: EditorState }) =>
    bookmarkedLines(host.state).map(({ line }) => host.state.doc.line(line).text)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    for (const sync of open.splice(0)) sync.destroy()
    vi.useRealTimers()
    resetBookmarks()
    resetBookmarkStatus()
    for (const notice of getNotices()) dismissNotice(notice.id)
})

describe('the editor and the bookmark list', () => {
    it('places the bookmarks of its document when it opens', async () => {
        setBookmarks([bookmarkOn(NOTES, 2)], null)
        const { host } = editorOver(NOTES)
        await settle()
        expect(markedTexts(host)).toEqual(['- dig the bed'])
    })

    it('settles once on a bookmark whose line is gone, rather than looking again and again', async () => {
        setBookmarks([bookmarkOn('- paint the fence\n- mend the gate', 2)], null)
        const { dispatches } = editorOver(NOTES)
        await settle()
        await settle(10 * WRITE_BACK_DELAY_MS)
        // The placing, and at most one full look when edits settle.
        expect(dispatches.length).toBeLessThanOrEqual(2)
    })

    it('says once that a position could not be saved, and tries again only after the next edit', async () => {
        const persist = vi.fn<BookmarksPersist>().mockRejectedValue(new Error('The disk is full.'))
        setBookmarks([bookmarkOn(NOTES, 2)], persist)
        const { host } = editorOver(NOTES)
        await settle()
        host.dispatch({ changes: { from: 0, insert: '- rake the path\n' } })
        await settle(WRITE_BACK_DELAY_MS)
        await settle(10 * WRITE_BACK_DELAY_MS)
        expect(persist).toHaveBeenCalledTimes(1)
        expect(getNotices().filter((n) => n.tone === 'error')).toHaveLength(1)
        expect(getNotices().at(-1)?.text).toMatch(/after your next edit/)

        host.dispatch({ changes: { from: 0, insert: '- sweep the yard\n' } })
        await settle(WRITE_BACK_DELAY_MS)
        expect(persist).toHaveBeenCalledTimes(2)
    })

    it('writes back where a bookmark moved once edits settle', async () => {
        setBookmarks([bookmarkOn(NOTES, 2)], null)
        const { host } = editorOver(NOTES)
        await settle()
        host.dispatch({ changes: { from: 0, insert: '- rake the path\n' } })
        await settle(WRITE_BACK_DELAY_MS)
        expect(getBookmarks()[0]).toMatchObject({ line: 2, text: 'dig the bed', before: 'water the beans' })
    })

    it('keeps the label of a bookmark whose line was deleted and then written back', async () => {
        setBookmarks([bookmarkOn(NOTES, 2)], null)
        const { host } = editorOver(NOTES)
        await settle()
        await setBookmarkLabel('b1', 'Start here')
        await settle()
        const line = host.state.doc.line(2)
        host.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete' })
        await settle()
        expect(getBookmarks()).toEqual([])
        host.dispatch({ changes: { from: line.from, insert: '- dig the bed\n' }, userEvent: 'undo' })
        await settle()
        expect(getBookmarks()).toEqual([expect.objectContaining({ id: 'b1', label: 'Start here' })])
    })

    it('writes nothing back, and restores nothing, while the document is protected', async () => {
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([bookmarkOn(NOTES, 2)], persist)
        const { host } = editorOver(NOTES, { protectedDoc: true })
        await settle()
        host.dispatch({ changes: { from: 0, insert: '- rake the path\n' } })
        await settle(WRITE_BACK_DELAY_MS)
        expect(persist).not.toHaveBeenCalled()
    })
})

describe('showing a bookmark', () => {
    it('shows the line when its editor has placed it, and focuses the editor', async () => {
        setBookmarks([bookmarkOn(NOTES, 3)], null)
        requestBookmarkReveal('b1', 'Garden')
        const { host } = editorOver(NOTES)
        await settle()
        expect(host.state.doc.lineAt(host.state.selection.main.head).number).toBe(3)
        expect(host.focus).toHaveBeenCalled()
        expect(pendingBookmarkReveal()).toBeNull()
    })

    it('shows the document from its top, and says why, when the line is not found', async () => {
        setBookmarks([bookmarkOn('- paint the fence\n- mend the gate', 2)], null)
        requestBookmarkReveal('b1', 'Garden')
        const { host } = editorOver(NOTES)
        await settle()
        await settle(WRITE_BACK_DELAY_MS)
        expect(pendingBookmarkReveal()).toBeNull()
        expect(host.state.selection.main.head).toBe(0)
        expect(getNotices().at(-1)?.text).toMatch(/no longer in "Garden"/)
    })

    it('leaves a request for another document to its own editor', async () => {
        setBookmarks([{ ...bookmarkOn(NOTES, 2), concept: 'Kitchen' }], null)
        requestBookmarkReveal('b1', 'Kitchen')
        editorOver(NOTES)
        await settle(WRITE_BACK_DELAY_MS)
        expect(pendingBookmarkReveal()).toEqual({ id: 'b1', concept: 'Kitchen' })
    })
})

describe('two editors of one document', () => {
    it('do not set each other writing when a bookmark of it is not found', async () => {
        // Two copies of a line with the same neighbours: each editor places it on the copy nearest its hint.
        const text = '- alpha\n- notes\n- alpha\n- notes\n- alpha'
        const repeated = bookmarkOn(text, 2, 'x')
        const gone: Bookmark = { id: 'y', concept: 'Garden', createdAt: 2, line: 0, text: 'mend the gate' }
        const persist = vi.fn<BookmarksPersist>().mockResolvedValue()
        setBookmarks([repeated, gone], persist)
        editorOver(text, { panelId: 'left' })
        await settle()
        setBookmarks([{ ...repeated, line: 3 }, gone], persist)
        editorOver(text, { panelId: 'right' })
        await settle()
        persist.mockClear()
        await settle(10 * WRITE_BACK_DELAY_MS)
        expect(persist.mock.calls.length).toBeLessThanOrEqual(2)
    })
})

describe('showing a bookmark, more', () => {
    it('answers at once in an open editor when the line is not found, and never moves the caret later', async () => {
        setBookmarks([bookmarkOn('- paint the fence\n- mend the gate', 2)], null)
        const { host } = editorOver(NOTES)
        await settle(WRITE_BACK_DELAY_MS)
        host.dispatch({ selection: { anchor: 10 } })
        requestBookmarkReveal('b1', 'Garden')
        expect(pendingBookmarkReveal()).toBeNull()
        expect(host.state.selection.main.head).toBe(0)
        expect(getNotices().find((n) => n.id === BOOKMARK_STATUS_NOTICE_ID)?.text).toMatch(/no longer in "Garden"/)
    })

    it('lets go of a request once the person works in the editor', async () => {
        setBookmarks([bookmarkOn('- paint the fence\n- mend the gate', 2)], null)
        const { host } = editorOver('')
        requestBookmarkReveal('b1', 'Garden')
        host.dispatch({ changes: { from: 0, insert: '- rake the path' }, selection: { anchor: 15 }, userEvent: 'input.type' })
        expect(pendingBookmarkReveal()).toBeNull()
        await settle(WRITE_BACK_DELAY_MS)
        expect(host.state.selection.main.head).toBe(15)
    })

    it('shows the line through the editor\'s held reveal when it has one', async () => {
        const reveal = vi.fn<NonNullable<BookmarkOptions['reveal']>>()
        setBookmarks([bookmarkOn(NOTES, 3)], null)
        requestBookmarkReveal('b1', 'Garden')
        editorOver(NOTES, { bookmarks: { reveal } })
        await settle()
        expect(reveal).toHaveBeenCalledWith({ line: 3 })
    })

    it('leaves no highlight in one editor when another shows a line soon after', async () => {
        const flashed = (state: EditorState) =>
            state
                .facet(EditorView.decorations)
                .filter((d): d is DecorationSet => typeof d !== 'function')
                .reduce((n, d) => n + d.size, 0)
        setBookmarks([bookmarkOn(NOTES, 2, 'g'), { ...bookmarkOn(NOTES, 1, 'k'), concept: 'Kitchen' }], null)
        const garden = editorOver(NOTES)
        const kitchen = editorOver(NOTES, { concept: 'Kitchen' })
        await settle()
        requestBookmarkReveal('g', 'Garden')
        await settle(300)
        requestBookmarkReveal('k', 'Kitchen')
        await settle(5000)
        expect(flashed(garden.host.state)).toBe(0)
        expect(flashed(kitchen.host.state)).toBe(0)
    })
})

describe('what the editor tells the person', () => {
    it('never says "Line not found" while the document\'s text is still arriving', async () => {
        setBookmarks([bookmarkOn(NOTES, 2)], null)
        const { host } = editorOver('')
        await settle()
        expect(missingBookmarkLines().has('b1')).toBe(false)
        host.dispatch({ changes: { from: 0, insert: NOTES }, annotations: EXTERNAL.of(true) })
        await settle(WRITE_BACK_DELAY_MS)
        expect(missingBookmarkLines().has('b1')).toBe(false)
        expect(markedTexts(host)).toEqual(['- dig the bed'])
    })

    it('says "Line not found" once a line not in the text was looked for in full', async () => {
        setBookmarks([bookmarkOn('- paint the fence\n- mend the gate', 2)], null)
        editorOver(NOTES)
        await settle()
        expect(missingBookmarkLines().has('b1')).toBe(true)
    })

    it('keeps a removal\'s Undo when a line is then refused', async () => {
        setBookmarks([bookmarkOn(NOTES, 2)], null)
        const { host } = editorOver(`${NOTES}\n`)
        await settle()
        await toggleBookmarkAtLine(host as unknown as EditorView, 2)
        await toggleBookmarkAtLine(host as unknown as EditorView, 4)
        const ids = getNotices().map((n) => n.id)
        expect(ids).toContain(BOOKMARK_NOTICE_ID)
        expect(ids).toContain(BOOKMARK_STATUS_NOTICE_ID)
    })

    it('announces a bookmark added, for a screen reader', async () => {
        setBookmarks([], null)
        const { host, dispatches } = editorOver(NOTES)
        await settle()
        await toggleBookmarkAtLine(host as unknown as EditorView, 2)
        const effects = dispatches.flat().flatMap((spec) => [spec.effects ?? []].flat() as StateEffect<unknown>[])
        expect(effects.some((e) => e.is(EditorView.announce) && e.value === 'Line 2 bookmarked')).toBe(true)
    })
})
