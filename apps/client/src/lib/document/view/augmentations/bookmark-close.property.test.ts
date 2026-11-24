import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { ViewUpdate } from '@codemirror/view'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dismissNotice, getNotices } from '#lib/activity/notices.js'

import { captureAnchor } from '../../bookmarks/anchor'
import { resetBookmarks, setBookmarks, type Bookmark, type BookmarksChange, type BookmarksSession } from '../../bookmarks/bookmarks'
import { editorDocument } from '../editor-document'
import { BookmarkSync, bookmarksAugmentation, WRITE_BACK_DELAY_MS } from './bookmarks'

/**
 * Editors and the bookmark list, opened and closed in any order with edits and waits between
 * (bookmarks.ts): a write refused because its graph closed raises no notice, and a write never
 * reaches the list of a graph other than the one its editor was open in.
 */

const TEXT = '- water the beans\n- dig the bed\n- feed the hens'

type Step = 'openGraph' | 'closeGraph' | 'openEditor' | 'closeEditor' | 'edit' | 'wait' | 'settle'

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261124 : Number(seed) }
}

function editorOn(graph: number): { sync: BookmarkSync; edit(): void } {
    let state = EditorState.create({ doc: TEXT, extensions: [editorDocument.of({ concept: `Garden ${graph}` }), bookmarksAugmentation()] })
    const host = {
        get state() {
            return state
        },
        dispatch(...specs: TransactionSpec[]) {
            const tr = state.update(...specs)
            const startState = state
            state = tr.state
            sync.update({ state, startState, docChanged: tr.docChanged, transactions: [tr] } as unknown as ViewUpdate)
        },
        focus() {},
    }
    const sync = new BookmarkSync(host as never)
    return { sync, edit: () => host.dispatch({ changes: { from: 0, insert: '- rake the path\n' } }) }
}

const microtasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetBookmarks()
    for (const notice of getNotices()) dismissNotice(notice.id)
})

describe('editors closing around their graph', () => {
    it('raise no notice, and write to no other graph, whatever the order', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const steps = fc.array(fc.constantFrom<Step>('openGraph', 'closeGraph', 'openEditor', 'closeEditor', 'edit', 'wait', 'settle'), { maxLength: 40 })
        await fc.assert(
            fc.asyncProperty(steps, async (order) => {
                vi.useFakeTimers()
                let graph = 0
                let session: BookmarksSession | null = null
                const editors: { sync: BookmarkSync; edit(): void }[] = []
                const strays: string[] = []
                try {
                    for (const step of order) {
                        if (step === 'openGraph') {
                            const id = ++graph
                            const bookmark: Bookmark = { id: `b${id}`, concept: `Garden ${id}`, createdAt: 1, ...captureAnchor(TEXT.split('\n'), 1)! }
                            session = setBookmarks([bookmark], async (change: BookmarksChange) => {
                                for (const put of change.put) if (put.concept !== `Garden ${id}`) strays.push(`${put.concept} into ${id}`)
                            })
                        } else if (step === 'closeGraph') {
                            void session?.close()
                            session = null
                        } else if (step === 'openEditor') editors.push(editorOn(graph))
                        else if (step === 'closeEditor') editors.shift()?.sync.destroy()
                        else if (step === 'edit') editors[0]?.edit()
                        else if (step === 'wait') await vi.advanceTimersByTimeAsync(WRITE_BACK_DELAY_MS)
                        else await microtasks()
                    }
                } finally {
                    void session?.close()
                    for (const { sync } of editors) sync.destroy()
                    await microtasks()
                    resetBookmarks()
                    await microtasks()
                }
                const notices = getNotices().map((notice) => notice.text)
                for (const notice of getNotices()) dismissNotice(notice.id)
                expect(notices).toEqual([])
                expect(strays).toEqual([])
            }),
            runs(300),
        )
    })
})
