import { describe, expect, it, vi } from 'vitest'

import {
    canCreateDocuments,
    createDraftDocument,
    promoteDraft,
    whenDocumentText,
    type DocumentCreatingStore,
} from './draft'
import type { DocumentStore, EditorDocument, TextChange } from './types'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

/**
 * [[Draft]] promotion (ADR 0050), exercised against fakes of both backends' shapes — the
 * [[Filesystem Backend]]'s frontmatter prefix and asynchronous hydration, and the
 * [[Server Backend]]'s synchronous, prefix-free create.
 */

function fakeDoc(initial: string): EditorDocument & { text: string; push(text: string): void } {
    const listeners = new Set<(t: string) => void>()
    const doc = {
        text: initial,
        id: 'fake',
        getText: () => doc.text,
        applyChange(change: TextChange) {
            doc.text = doc.text.slice(0, change.from) + change.insert + doc.text.slice(change.to)
        },
        subscribe(listener: (t: string) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        push(text: string) {
            doc.text = text
            for (const l of listeners) l(text)
        },
    }
    return doc
}

/** A Server Backend-shaped store: create is instant and the document has no prefix. */
function serverLikeStore(): DocumentCreatingStore & { docs: Map<string, ReturnType<typeof fakeDoc>> } {
    const docs = new Map<string, ReturnType<typeof fakeDoc>>()
    return {
        docs,
        async createPage(title, body = '') {
            if (docs.has(title)) throw new Error('exists')
            docs.set(title, fakeDoc(body))
            return title
        },
        async createJournal(date, body = '') {
            if (docs.has(date)) throw new Error('exists')
            docs.set(date, fakeDoc(body))
            return date
        },
        open(target) {
            const doc = docs.get(target)
            if (!doc) throw new Error('missing')
            return doc
        },
        whenReady: async () => {},
    }
}

/** A Filesystem Backend-shaped store: a frontmatter prefix, and `open` hydrates late. */
function filesystemLikeStore(delayMs = 0) {
    const files = new Map<string, string>()
    const store: DocumentCreatingStore & { files: Map<string, string> } = {
        files,
        async createPage(title, body = '') {
            if (files.has(title)) throw new Error('exists')
            files.set(title, `---\ntitle: ${title}\n---\n${body}`)
            return title
        },
        // A journal entry has no frontmatter: the day is its identity (ADR 0056), so the body
        // is the whole file and the promoted caret sits where the Draft left it.
        async createJournal(date, body = '') {
            if (files.has(date)) throw new Error('exists')
            files.set(date, body)
            return date
        },
        open(target) {
            const content = files.get(target)
            if (content === undefined) throw new Error('missing')
            // Mirrors the real store: an empty buffer, hydrated asynchronously.
            const doc = fakeDoc('')
            setTimeout(() => doc.push(content), delayMs)
            // Writes go back to the file, as the real handle's autosave would.
            const applyChange = doc.applyChange.bind(doc)
            doc.applyChange = (change) => {
                applyChange(change)
                files.set(target, doc.text)
            }
            return doc
        },
    }
    return store
}

describe('createDraftDocument', () => {
    it('starts empty and reports no content', () => {
        const draft = createDraftDocument('Kanban', () => {})
        expect(draft.getText()).toBe('')
        expect(draft.hasContent()).toBe(false)
        expect(draft.isDraft).toBe(true)
        expect(draft.concept).toBe('Kanban')
    })

    it('fires onFirstChange exactly once, on the first real change', () => {
        const onFirstChange = vi.fn()
        const draft = createDraftDocument('Kanban', onFirstChange)
        draft.applyChange({ from: 0, to: 0, insert: 'a' })
        draft.applyChange({ from: 1, to: 1, insert: 'b' })
        draft.applyChange({ from: 0, to: 2, insert: '' })
        expect(onFirstChange).toHaveBeenCalledTimes(1)
        expect(draft.getText()).toBe('')
    })

    it('does not promote on a change that alters nothing', () => {
        // Replacing a range with itself is a document change as far as CodeMirror is
        // concerned; promotion must mean content, not activity.
        const onFirstChange = vi.fn()
        const draft = createDraftDocument('Kanban', onFirstChange)
        draft.applyChange({ from: 0, to: 0, insert: '' })
        expect(onFirstChange).not.toHaveBeenCalled()
        expect(draft.hasContent()).toBe(false)
    })

    it('accumulates edits like any buffer', () => {
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'hello world' })
        draft.applyChange({ from: 5, to: 11, insert: '' })
        expect(draft.getText()).toBe('hello')
        expect(draft.hasContent()).toBe(true)
    })
})

describe('whenDocumentText', () => {
    it('uses whenReady when the store has one', async () => {
        const store = serverLikeStore()
        await store.createPage('A', 'seeded')
        const doc = store.open('A')
        await expect(whenDocumentText(store, doc, 'A')).resolves.toBe('seeded')
    })

    it('waits for a late hydration when the store has no whenReady', async () => {
        const store = filesystemLikeStore(5)
        await store.createPage('A', 'body')
        const doc = store.open('A')
        expect(doc.getText()).toBe('')
        await expect(whenDocumentText(store, doc, 'A')).resolves.toBe('---\ntitle: A\n---\nbody')
    })

    it('settles on a genuinely empty document rather than hanging', async () => {
        const store = filesystemLikeStore(10_000)
        await store.createPage('A')
        const doc = store.open('A')
        await expect(whenDocumentText(store, doc, 'A', 5)).resolves.toBe('')
    })
})

describe('promoteDraft', () => {
    it('seeds the page with the draft text in one write (server-shaped)', async () => {
        const store = serverLikeStore()
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'first thoughts' })

        const promoted = await promoteDraft(store, draft)
        expect(promoted).toEqual({
            concept: 'Kanban',
            text: 'first thoughts',
            bodyOffset: 0,
        })
        expect(store.docs.get('Kanban')!.text).toBe('first thoughts')
    })

    it('reports the frontmatter prefix as bodyOffset (filesystem-shaped)', async () => {
        const store = filesystemLikeStore()
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'first thoughts' })

        const promoted = await promoteDraft(store, draft)
        expect(promoted.text).toBe('---\ntitle: Kanban\n---\nfirst thoughts')
        // The caret was at offset 14 in the Draft; it is at bodyOffset + 14 in the page.
        expect(promoted.text.slice(promoted.bodyOffset)).toBe('first thoughts')
    })

    it('keeps characters typed while the create was in flight', async () => {
        // The gap that makes buffering necessary: a Filesystem Backend create is a directory
        // write plus a full registry refresh, and the user keeps typing through it.
        const store = filesystemLikeStore(2)
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'ab' })

        const promotion = promoteDraft(store, draft)
        draft.applyChange({ from: 2, to: 2, insert: 'cde' })
        const promoted = await promotion

        expect(promoted.text.slice(promoted.bodyOffset)).toBe('abcde')
        expect(store.files.get('Kanban')).toBe('---\ntitle: Kanban\n---\nabcde')
    })

    it('adopts an existing document rather than losing the draft text', async () => {
        // A second tab, or a Player who created the page while this Draft was open.
        const store = serverLikeStore()
        await store.createPage('Kanban', 'theirs')
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'mine' })

        const promoted = await promoteDraft(store, draft)
        expect(promoted.text).toBe('theirs\nmine')
        expect(promoted.text.slice(promoted.bodyOffset)).toBe('mine')
        expect(store.docs.get('Kanban')!.text).toBe('theirs\nmine')
    })

    it('adopts without a stray blank line when the existing text ends in a newline', async () => {
        const store = serverLikeStore()
        await store.createPage('Kanban', 'theirs\n')
        const draft = createDraftDocument('Kanban', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'mine' })

        expect((await promoteDraft(store, draft)).text).toBe('theirs\nmine')
    })
})

describe('promoteDraft — which kind the concept decides (ADR 0056)', () => {
    it('promotes a day into a journal entry, with no frontmatter ahead of the body', async () => {
        const store = filesystemLikeStore()
        const draft = createDraftDocument('2026-08-01', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'backfilled' })

        const promoted = await promoteDraft(store, draft)
        expect(promoted.concept).toBe('2026-08-01')
        // A page would carry a `title` block; a journal entry's identity is the day itself, so
        // the body starts at 0 and the caret does not shift under the user on promotion.
        expect(promoted.bodyOffset).toBe(0)
        expect(store.files.get('2026-08-01')).toBe('backfilled')
    })

    it('promotes a date-shaped non-day into a page', async () => {
        const store = filesystemLikeStore()
        const draft = createDraftDocument('2026-02-30', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'x' })

        await promoteDraft(store, draft)
        // 30 February is not a day, so it is an ordinary concept and gets a page's frontmatter.
        expect(store.files.get('2026-02-30')).toContain('title: 2026-02-30')
    })

    it('adopts the document already at that day rather than overwriting it', async () => {
        const store = serverLikeStore()
        await store.createJournal('2026-08-01', 'theirs')
        const draft = createDraftDocument('2026-08-01', () => {})
        draft.applyChange({ from: 0, to: 0, insert: 'mine' })

        expect((await promoteDraft(store, draft)).text).toBe('theirs\nmine')
    })

    it('reaches journals/ through the real Filesystem store, which refuses a day as a page', async () => {
        // The route a `[[2026-09-01]]` wikilink, a Quick Find row and a calendar day all take.
        // The store's createPage refuses a day outright, so this pins that the Draft never asks
        // it to: the refusal would otherwise be swallowed as an adopt and the text lost.
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        const draft = createDraftDocument('2026-09-01', () => {})
        draft.applyChange({ from: 0, to: 0, insert: '- written from a wikilink' })

        const promoted = await promoteDraft(store, draft)
        expect(promoted.concept).toBe('2026-09-01')
        expect(store.listDocuments().find((d) => d.concept === '2026-09-01')?.kind).toBe('journal')
        await store.flushDocument('2026-09-01')
        expect((await adapter.read('journals', '2026-09-01.md')).text).toBe('- written from a wikilink')
        expect(await adapter.list('pages')).toEqual([])
        await store.dispose()
    })
})

describe('canCreateDocuments', () => {
    it('recognises a store that can create documents, and one that cannot', () => {
        expect(canCreateDocuments(serverLikeStore())).toBe(true)
        expect(canCreateDocuments({ open: () => fakeDoc('') })).toBe(false)
        // A store with only half the seam cannot promote a Draft either way.
        const halfSeam = { open: () => fakeDoc(''), createPage: async (t: string) => t }
        expect(canCreateDocuments(halfSeam as unknown as DocumentStore)).toBe(false)
    })
})
