import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryAdapter } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import {
    type DocumentConflict,
    createFilesystemDocumentStore,
} from './filesystem-store'

function clock(start = 1000) {
    let t = start
    return () => (t += 1000)
}

/** Let the open()-time async hydration read resolve. */
async function flushMicrotasks() {
    await Promise.resolve()
    await Promise.resolve()
}

describe('FilesystemDocumentStore — open, hydrate, autosave', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('open() returns empty then hydrates via an external-style notification', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'Physics.md': '# Physics' } },
        })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        const doc = store.open('Physics')
        expect(doc.getText()).toBe('') // synchronous: empty seed
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        await flushMicrotasks()
        expect(doc.getText()).toBe('# Physics')
        expect(seen).toEqual(['# Physics']) // hydration delivered the external way
    })

    it('applyChange mutates the buffer, autosaves to disk, and does NOT notify', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()

        const doc = store.open('A')
        await flushMicrotasks() // hydrate to 'a'
        const notified: string[] = []
        doc.subscribe((t) => notified.push(t))

        doc.applyChange({ from: 1, to: 1, insert: 'X' }) // 'a' -> 'aX'
        expect(doc.getText()).toBe('aX')
        expect(notified).toEqual([]) // local edit: no notify

        await vi.advanceTimersByTimeAsync(400)
        expect((await fs.read('pages', 'A.md')).text).toBe('aX')
    })
})

describe('FilesystemDocumentStore — scan, createPage, createJournal', () => {
    it('lists documents and fires change events on create', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        let changes = 0
        store.onDocumentsChanged(() => changes++)

        await store.scan()
        expect(store.listDocuments()).toEqual([])

        const concept = await store.createPage('My Page')
        expect(concept).toBe('My Page')
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['My Page'])
        expect((await fs.read('pages', 'My Page.md')).text).toContain('title: My Page')
        expect(changes).toBeGreaterThan(0)
    })

    it('rejects a case-insensitive page collision', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await store.createPage('My Page')
        await expect(store.createPage('my page')).rejects.toThrow()
    })

    it('gives a second concept whose portable name is taken a suffixed file, keeping both', async () => {
        // `etc` and `etc.` are two concepts on one stem (the guard strips trailing dots), so the
        // second create truncated the first document's file. Suffix the file, keep the title.
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        await store.createPage('etc', '- first')
        await store.createPage('etc.', '- second')

        expect((await fs.list('pages')).map((e) => e.name).sort()).toEqual(['etc (2).md', 'etc.md'])
        expect((await fs.read('pages', 'etc.md')).text).toContain('- first')
        const second = (await fs.read('pages', 'etc (2).md')).text
        expect(second).toContain('title: etc.')
        expect(second).toContain('- second')
        // Both survive a rescan as the concepts they are: the suffix names a file, not a page.
        await store.scan()
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['etc', 'etc.'])
    })

    it('skips a name already on disk that the registry has not scanned yet', async () => {
        // A file added behind the store's back (a sync tool, a second tab) is on disk but not
        // in the registry; writing over it would lose it just the same.
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await fs.write('pages', 'Fresh.md', '---\ntitle: Fresh\n---\n- unscanned')

        await store.createPage('Fresh.')

        expect((await fs.read('pages', 'Fresh.md')).text).toContain('- unscanned')
        expect((await fs.read('pages', 'Fresh (2).md')).text).toContain('title: Fresh.')
    })

    it('onChange fires on create and on autosave; snapshotForIndex returns body + aliases', async () => {
        vi.useFakeTimers()
        try {
            const fs = createMemoryDirectoryAdapter({ now: clock() })
            const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
            await store.scan()
            let changes = 0
            store.onChange(() => changes++)

            await store.createPage('Physics') // registry change → onChange
            expect(changes).toBeGreaterThan(0)

            // Seed a page with frontmatter (title + aliases) and a body to index.
            await fs.write('pages', 'Notes.md', '---\ntitle: Notes\naliases:\n  - Jotter\n---\nsee [[Physics]]')
            await store.scan()

            const snapshot = await store.snapshotForIndex()
            const notes = snapshot.find((d) => d.concept === 'Notes')
            expect(notes).toMatchObject({ kind: 'page', aliases: ['Jotter'] })
            expect(notes!.text).toBe('see [[Physics]]') // frontmatter stripped
            // An ordinary page carries no include facts at all, not an empty list.
            expect(notes).not.toHaveProperty('includes')

            // A publication page's includes travel with it (ADR 0082), so the index can flag
            // the snippets it names; the body stays the outline below the block.
            await fs.write('pages', 'Docs.md', '---\ntitle: Docs\npublication:\n  id: docs\n  includes:\n    footer: Site Footer\n---\n- [[Notes]]')
            await store.scan()
            const docs = (await store.snapshotForIndex()).find((d) => d.concept === 'Docs')
            expect(docs).toMatchObject({ text: '- [[Notes]]', includes: [{ publication: 'docs', slot: 'footer', concept: 'Site Footer' }] })
            expect(await store.snapshotDocument('Docs')).toMatchObject({ includes: [{ publication: 'docs', slot: 'footer', concept: 'Site Footer' }] })

            const before = changes
            const doc = store.open('Physics')
            await flushMicrotasks()
            doc.applyChange({ from: 0, to: 0, insert: 'x' })
            await vi.advanceTimersByTimeAsync(400) // autosave → onChange
            expect(changes).toBeGreaterThan(before)
        } finally {
            vi.useRealTimers()
        }
    })

    it("names the document on its own saves, and snapshotDocument returns that one document", async () => {
        // An unnamed change makes the index re-derive the WHOLE graph; a named one costs one
        // document. Every autosave used to be unnamed, so a ticked checkbox re-read every file.
        vi.useFakeTimers()
        try {
            const fs = createMemoryDirectoryAdapter({ now: clock() })
            const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
            await fs.write('pages', 'Notes.md', '---\ntitle: Notes\naliases:\n  - Jotter\n---\nsee [[Physics]]')
            await fs.write('pages', 'Other.md', '---\ntitle: Other\n---\nunopened body')
            await store.scan()
            const changes: Array<{ concept: string } | undefined> = []
            store.onChange((change) => changes.push(change))

            const doc = store.open('Notes')
            await store.whenReady('Notes')
            const end = doc.getText().length
            doc.applyChange({ from: end, to: end, insert: ' and more' })
            await vi.advanceTimersByTimeAsync(400) // autosave
            expect(changes).toEqual([{ concept: 'Notes' }])

            // Open: the live buffer, frontmatter stripped, aliases read from it.
            expect(await store.snapshotDocument('Notes')).toEqual({
                concept: 'Notes',
                kind: 'page',
                aliases: ['Jotter'],
                text: 'see [[Physics]] and more',
            })
            // Not open: read from disk. Case-insensitive, like every other lookup.
            expect(await store.snapshotDocument('other')).toMatchObject({ concept: 'Other', text: 'unopened body' })
            // Not a document at all.
            expect(await store.snapshotDocument('Nowhere')).toBeNull()

            // A registry change (a new file) is still unnamed: the index must re-verify.
            await store.createPage('Physics')
            expect(changes.at(-1)).toBeUndefined()
        } finally {
            vi.useRealTimers()
        }
    })

    it('createJournal writes the day into journals/, seeded and without frontmatter', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        expect(await store.createJournal('2026-06-02', 'first light')).toBe('2026-06-02')
        expect((await fs.list('journals')).map((e) => e.name)).toEqual(['2026-06-02.md'])
        // No `title` block: a journal entry's identity is its filename (ADR 0056), which is what
        // keeps a promoting Draft's caret where the user left it.
        expect((await fs.read('journals', '2026-06-02.md')).text).toBe('first light')
        expect(store.listDocuments().find((d) => d.concept === '2026-06-02')?.kind).toBe('journal')
    })

    it('createJournal refuses a day that does not exist', async () => {
        const store = createFilesystemDocumentStore(createMemoryDirectoryAdapter({ now: clock() }))
        await store.scan()
        await expect(store.createJournal('2026-02-30')).rejects.toThrow(/not a calendar day/)
        await expect(store.createJournal('2026-13-01')).rejects.toThrow(/not a calendar day/)
    })

    it('createJournal refuses a day something already resolves to', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await store.createJournal('2026-06-02')
        // The Draft that lost this race adopts the existing document rather than overwriting it.
        await expect(store.createJournal('2026-06-02')).rejects.toThrow(/already exists/)
    })

    it('createPage refuses a day and writes nothing: a day is its journal entry\'s name (ADR 0056)', async () => {
        // The shape an older version left behind: `pages/2026-09-01.md`, a page answering to a
        // day. Every caller that means the journal entry calls createJournal; a caller that
        // reaches createPage with a day has a bug, and is told so instead of misfiling the day.
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await expect(store.createPage('2026-09-01', '- x')).rejects.toThrow('“2026-09-01” is a date')
        await expect(store.createPage(' 2026-09-01 ')).rejects.toThrow('“2026-09-01” is a date')
        expect(await fs.list('pages')).toEqual([])
        expect(await fs.list('journals')).toEqual([])
        expect(store.listDocuments()).toEqual([])
    })

    it('createPage still makes a page of a date-shaped name that is no day', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock() })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        expect(await store.createPage('2026-13-45')).toBe('2026-13-45')
        expect((await fs.list('pages')).map((e) => e.name)).toEqual(['2026-13-45.md'])
    })
})

describe('FilesystemDocumentStore — external-change reconciliation', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** Build a store with a hydrated open doc; returns helpers. */
    async function openOne(seedText: string, opts?: { onConflict?: (c: DocumentConflict) => void }) {
        const tick = clock()
        const fs = createMemoryDirectoryAdapter({ now: tick, seed: { pages: { 'A.md': seedText } } })
        const store = createFilesystemDocumentStore(fs, {
            autosaveMs: 400,
            onConflict: opts?.onConflict,
        })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()
        return { fs, store, doc }
    }

    it('reloads a clean buffer when the file changes on disk', async () => {
        const { fs, store, doc } = await openOne('original')
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        await fs.write('pages', 'A.md', 'edited externally') // mtime advances (behind the store's back)
        await store.reconcile()

        expect(seen).toEqual(['edited externally'])
        expect(doc.getText()).toBe('edited externally')
    })

    it('does nothing when disk is unchanged', async () => {
        const { store, doc } = await openOne('stable')
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))
        await store.reconcile()
        expect(seen).toEqual([])
    })

    it('reloads an external edit that kept the mtime but changed the size', async () => {
        // A write inside the timestamp's resolution (2 s on exFAT, 1 s on HFS+), a tool that
        // preserves mtime (`rsync -t`, `cp -p`), or an edit between our close() and the
        // post-write re-read: the mtime alone said "unchanged" and the next autosave wrote
        // over it. The listing's byte size is free and catches the length moving.
        const frozen = 1000
        const fs = createMemoryDirectoryAdapter({ now: () => frozen, seed: { pages: { 'A.md': 'original' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        await fs.write('pages', 'A.md', 'original, edited') // stamped with the SAME mtime
        await store.reconcile()

        expect(seen).toEqual(['original, edited'])
        expect(doc.getText()).toBe('original, edited')
    })

    it('skips the per-document read when both mtime and size match what it last synced', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'stable' } } })
        const reads: string[] = []
        const counted = {
            ...fs,
            read: async (subdir: 'pages', name: string) => {
                reads.push(name)
                return fs.read(subdir, name)
            },
        }
        const store = createFilesystemDocumentStore(counted as typeof fs, { autosaveMs: 400 })
        await store.scan() // one read: the scan parses every file
        store.open('A')
        await flushMicrotasks() // two: hydration
        expect(reads).toHaveLength(2)

        await store.reconcile()

        // Still two: the rescan reuses the entry of a file that has not moved, and the open
        // document's own stamps match, so neither side opens the file.
        expect(reads).toHaveLength(2)
    })

    it('raises a conflict for a dirty buffer and resolves both ways', async () => {
        const conflicts: DocumentConflict[] = []
        const { fs, store, doc } = await openOne('base', { onConflict: (c) => conflicts.push(c) })

        doc.applyChange({ from: 4, to: 4, insert: ' mine' }) // 'base' -> 'base mine' (dirty)
        await fs.write('pages', 'A.md', 'base theirs') // external edit under dirty buffer
        await store.reconcile()

        expect(conflicts).toHaveLength(1)
        expect(conflicts[0]).toMatchObject({ target: 'A', diskText: 'base theirs' })
        expect(doc.getText()).toBe('base mine') // buffer untouched

        await store.resolveConflict('A', 'take-disk')
        expect(doc.getText()).toBe('base theirs')

        // A fresh conflict, resolved keep-mine, writes our buffer to disk.
        doc.applyChange({ from: 0, to: 0, insert: 'Z' })
        await fs.write('pages', 'A.md', 'changed again')
        await store.reconcile()
        await store.resolveConflict('A', 'keep-mine')
        expect((await fs.read('pages', 'A.md')).text).toBe(doc.getText())
    })

    it('flags an open document that vanishes on disk', async () => {
        const { fs, store, doc } = await openOne('here')
        const removed: string[] = []
        store.onDocumentRemoved((t) => removed.push(t))

        await fs.remove('pages', 'A.md')
        await store.reconcile()

        expect(removed).toEqual(['A'])
        expect(store.listDocuments().map((e) => e.concept)).not.toContain('A')
        void doc
    })
})

describe('external edits', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('notifies subscribers for an external change but not for the editor’s own', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        const doc = store.open('A')
        await flushMicrotasks()
        expect(doc.getText()).toBe('a')

        const seen: string[] = []
        doc.subscribe((text) => seen.push(text))

        // The editor's own edit: the editor already shows it, so no echo.
        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        expect(seen).toEqual([])
        expect(doc.getText()).toBe('aX')

        // An edit from anywhere else (the Tasks View ticking a box) MUST be announced,
        // or an open editor keeps rendering text the buffer no longer holds.
        doc.applyChange({ from: 2, to: 2, insert: 'Y' }, 'external')
        expect(seen).toEqual(['aXY'])
    })
})

describe('FilesystemDocumentStore — whenReady', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('resolves only once the text is really there, so a reader never sees the empty seed', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'Kanban.md': '- [ ] #P1 TEst task' } },
        })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        // Nobody has opened Kanban. Asking whenReady is what opens it AND waits for the read.
        await store.whenReady('Kanban')

        expect(store.open('Kanban').getText()).toBe('- [ ] #P1 TEst task')
    })

    it('is immediate for a document already hydrated', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        store.open('A')
        await flushMicrotasks()

        let settled = false
        void store.whenReady('A').then(() => (settled = true))
        await flushMicrotasks()

        expect(settled).toBe(true)
    })

    it('still resolves when the file cannot be read, leaving the buffer empty rather than hanging', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Gone.md': 'x' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await fs.remove('pages', 'Gone.md') // registry still lists it; the read will fail

        await expect(store.whenReady('Gone')).resolves.toBeUndefined()
        expect(store.open('Gone').getText()).toBe('')
    })
})

describe('FilesystemDocumentStore — reconcile during our own in-flight write', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('does not mistake a save that is still landing for an external edit', async () => {
        // The race from a real folder: the write has reached disk (so a directory listing
        // reports the new mtime) but has not yet resolved back to the store, so baseText and
        // dirty still describe the pre-save state. A focus event or the poll fires reconcile
        // in that window. Without a guard the verdict is "conflict" - the app's own save,
        // reported as "changed on disk while you have unsaved edits", and autosave paused.
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': '- [ ] task' } } })
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        const slow = {
            ...fs,
            // Land the bytes, then hold the acknowledgement back.
            write: async (subdir: 'pages', name: string, text: string) => {
                const res = await fs.write(subdir, name, text)
                await gate
                return res
            },
        }
        const conflicts: unknown[] = []
        const store = createFilesystemDocumentStore(slow as typeof fs, {
            autosaveMs: 10,
            onConflict: (c) => conflicts.push(c),
        })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()

        doc.applyChange({ from: 3, to: 4, insert: 'x' }, 'external')
        await vi.advanceTimersByTimeAsync(20) // autosave fires; write reaches disk; ack held

        // Focus / the poll fires reconcile mid-write. The guard makes it WAIT for the write, so
        // the acknowledgement has to be released while reconcile is pending - which is exactly
        // the shape of the real thing: the write completes on its own a moment later.
        const reconciling = store.reconcile()
        await flushMicrotasks()
        expect(conflicts).toEqual([]) // nothing decided yet, one way or the other
        release()
        await reconciling

        expect(conflicts).toEqual([])
        expect(doc.getText()).toBe('- [x] task')
        expect((await fs.read('pages', 'Kanban.md')).text).toBe('- [x] task')
    })
})

describe('FilesystemDocumentStore — flushDocument', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    // A protect is reported as done the moment the fence is in the buffer; the file would stay
    // plaintext until the autosave timer fired. Flushing closes that window.
    it('writes a pending autosave now, without waiting for the timer', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()

        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        expect((await fs.read('pages', 'A.md')).text).toBe('a')

        await store.flushDocument('A')

        expect((await fs.read('pages', 'A.md')).text).toBe('aX')
    })

    it('is a no-op for a document that is not open', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()

        await expect(store.flushDocument('A')).resolves.toBeUndefined()
        await expect(store.flushDocument('Nope')).resolves.toBeUndefined()
    })

    // A check that reads the folder (the orphan scan) must see an edit still in its debounce.
    it('flushAll writes every pending autosave now', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a', 'B.md': 'b' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const a = store.open('A')
        const b = store.open('B')
        await flushMicrotasks()
        a.applyChange({ from: 1, to: 1, insert: 'X' })
        b.applyChange({ from: 1, to: 1, insert: 'Y' })

        await store.flushAll()

        expect((await fs.read('pages', 'A.md')).text).toBe('aX')
        expect((await fs.read('pages', 'B.md')).text).toBe('bY')
    })
})

// ── Frontmatter identity is a proposal (ADR 0061) ──────────────────────────────────────────────
describe('FilesystemDocumentStore — identity written in the block', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const KANBAN = '---\ntitle: Kanban\n---\nbody'

    it('keeps the registry title on disk under a typed one, and still saves the body', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': KANBAN } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()
        const removed: string[] = []
        store.onDocumentRemoved((t) => removed.push(t))

        doc.applyChange({ from: 0, to: KANBAN.length, insert: '---\ntitle: Kanban 2\n---\nbody edited' })
        await vi.advanceTimersByTimeAsync(400)

        // The buffer proposes; the file does not.
        expect(doc.getText()).toBe('---\ntitle: Kanban 2\n---\nbody edited')
        expect((await fs.read('pages', 'Kanban.md')).text).toBe('---\ntitle: Kanban\n---\nbody edited')
        // So a rescan finds the same document under the same name and declares nothing removed.
        await store.reconcile()
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['Kanban'])
        expect(removed).toEqual([])
        expect(doc.getText()).toBe('---\ntitle: Kanban 2\n---\nbody edited')
    })

    it('puts a block back when the buffer dropped it and the file name is not the title', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'kanban-2.md': '---\ntitle: Kanban 2\n---\nbody' } },
        })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Kanban 2')
        await flushMicrotasks()

        doc.applyChange({ from: 0, to: doc.getText().length, insert: 'body only' })
        await vi.advanceTimersByTimeAsync(400)

        expect((await fs.read('pages', 'kanban-2.md')).text).toBe('---\ntitle: Kanban 2\n---\nbody only')
    })

    it('writes typed aliases as they are, and the registry follows on the save', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': KANBAN } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()

        doc.applyChange({ from: 0, to: KANBAN.length, insert: '---\ntitle: Kanban\naliases: [Board]\n---\nbody' })
        await vi.advanceTimersByTimeAsync(400)

        expect((await fs.read('pages', 'Kanban.md')).text).toContain('aliases: [Board]')
        expect(store.listDocuments()[0].aliases).toEqual(['Board'])
    })

    it('setAliases rewrites the block of an open document and tells its editor', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': KANBAN } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        await store.setAliases('Kanban', ['Board', 'kanban'])
        await vi.advanceTimersByTimeAsync(400)

        const expected = '---\ntitle: Kanban\naliases:\n  - Board\n---\nbody'
        expect(doc.getText()).toBe(expected)
        expect(seen.at(-1)).toBe(expected)
        expect((await fs.read('pages', 'Kanban.md')).text).toBe(expected)
        expect(store.listDocuments()[0].aliases).toEqual(['Board'])
    })

    it('setAliases rewrites the file of a document nobody has open', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': KANBAN } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        await store.setAliases('Kanban', ['Board'])

        expect((await fs.read('pages', 'Kanban.md')).text).toBe('---\ntitle: Kanban\naliases:\n  - Board\n---\nbody')
        expect(store.listDocuments()[0].aliases).toEqual(['Board'])
    })
})

describe('FilesystemDocumentStore — a title edited outside the app', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('is a rename that already happened: the open document follows its file', async () => {
        const now = clock()
        const fs = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Kanban.md': '---\ntitle: Kanban\n---\nbody' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 400 })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()
        const removed: string[] = []
        const renamed: [string, string][] = []
        store.onDocumentRemoved((t) => removed.push(t))
        store.onDocumentRenamed((from, to) => renamed.push([from, to]))
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        await fs.write('pages', 'Kanban.md', '---\ntitle: Kanban 2\n---\nbody edited elsewhere')
        await store.reconcile()

        expect(renamed).toEqual([['Kanban', 'Kanban 2']])
        expect(removed).toEqual([])
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['Kanban 2'])
        // The same buffer, now answering to the new name, reloaded from disk since it was clean.
        expect(store.open('Kanban 2')).toBe(doc)
        expect(doc.getText()).toBe('---\ntitle: Kanban 2\n---\nbody edited elsewhere')
        expect(seen.at(-1)).toBe(doc.getText())
        // ...and it keeps saving to its file under the new name.
        doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: '!' })
        await vi.advanceTimersByTimeAsync(400)
        expect((await fs.read('pages', 'Kanban.md')).text).toBe('---\ntitle: Kanban 2\n---\nbody edited elsewhere!')
    })

    it('raises a conflict, not a removal, when the buffer was dirty', async () => {
        const now = clock()
        const fs = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Kanban.md': '---\ntitle: Kanban\n---\nbody' } } })
        const conflicts: DocumentConflict[] = []
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 60_000, onConflict: (c) => conflicts.push(c) })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()
        doc.applyChange({ from: 0, to: 0, insert: 'mine ' })

        await fs.write('pages', 'Kanban.md', '---\ntitle: Kanban 2\n---\ntheirs')
        await store.reconcile()

        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].target).toBe('Kanban 2')
        expect(store.open('Kanban 2')).toBe(doc)
    })
})

// ── One write at a time per document ───────────────────────────────────────────────────────────
describe('FilesystemDocumentStore - autosave is serialised per document', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /**
     * An adapter whose writes to `gatedName` wait to be released, one release per write, in
     * order. `bytes: 'before-release'` lands the bytes first and holds the acknowledgement (a
     * write reached disk, the store has not heard yet); `'after-release'` lands them on release,
     * the shape of a File System Access `createWritable()`, whose swap file becomes the file at
     * `close()`. Other names write straight through.
     */
    function gatedWrites(fs: DirectoryAdapter, gatedName: string, bytes: 'before-release' | 'after-release') {
        const releases: Array<() => void> = []
        const gate = () => new Promise<void>((release) => releases.push(release))
        const adapter: DirectoryAdapter = {
            ...fs,
            write: async (subdir, name, text) => {
                if (name !== gatedName) return fs.write(subdir, name, text)
                if (bytes === 'after-release') {
                    await gate()
                    return fs.write(subdir, name, text)
                }
                const res = await fs.write(subdir, name, text)
                await gate()
                return res
            },
        }
        return { adapter, started: () => releases.length, release: (index: number) => releases[index]() }
    }

    /** Let promise chains that need more than two hops (a settled write, a queued rerun) run. */
    async function settle() {
        for (let i = 0; i < 8; i++) await Promise.resolve()
    }

    it('starts one write at a time, and a write wanted mid-flight carries the latest buffer', async () => {
        // Two writables open on one file have no ordering, so the older text could land last;
        // and the first to settle nulled the pointer while the newer was still open, which let a
        // reconcile pass read the app's own write as an external edit and raise a conflict.
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const gate = gatedWrites(fs, 'A.md', 'before-release')
        const conflicts: DocumentConflict[] = []
        const store = createFilesystemDocumentStore(gate.adapter, { autosaveMs: 10, onConflict: (c) => conflicts.push(c) })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()

        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10) // the first write is open: bytes down, ack held
        expect(gate.started()).toBe(1)

        doc.applyChange({ from: 2, to: 2, insert: 'Y' })
        await vi.advanceTimersByTimeAsync(10)
        doc.applyChange({ from: 3, to: 3, insert: 'Z' })
        await vi.advanceTimersByTimeAsync(10)
        expect(gate.started()).toBe(1) // wanted, not started: one writable per file

        // A focus / poll reconcile in that window waits for every write, then finds nothing.
        const reconciling = store.reconcile()
        await settle()
        expect(conflicts).toEqual([])

        gate.release(0)
        await settle()
        expect(gate.started()).toBe(2) // the queued write, with everything typed since
        gate.release(1)
        await reconciling

        expect(conflicts).toEqual([])
        expect(doc.getText()).toBe('aXYZ')
        expect((await fs.read('pages', 'A.md')).text).toBe('aXYZ')
        await store.flushDocument('A')
        expect(gate.started()).toBe(2) // nothing left to write
    })

    it('waits for an in-flight write before renaming, so the new file is not stale and the old not recreated', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': '---\ntitle: A\n---\na' } } })
        const gate = gatedWrites(fs, 'A.md', 'after-release')
        const store = createFilesystemDocumentStore(gate.adapter, { autosaveMs: 10 })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()
        doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10) // write open, bytes not yet visible
        expect(gate.started()).toBe(1)

        const renaming = store.renamePage('A', 'B', { strategy: 'alias' })
        await settle()
        gate.release(0)
        await renaming

        expect(await fs.exists('pages', 'A.md')).toBe(false) // not recreated by the writable closing late
        expect((await fs.read('pages', 'B.md')).text).toContain('aX') // renamed AFTER the write, so not stale
        expect(store.listDocuments().map((d) => d.concept)).toEqual(['B'])
    })

    it('waits for an in-flight write before deleting, so the file is not recreated at close', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const gate = gatedWrites(fs, 'A.md', 'after-release')
        const store = createFilesystemDocumentStore(gate.adapter, { autosaveMs: 10 })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()
        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10)
        expect(gate.started()).toBe(1)

        const deleting = store.deleteDocument('A')
        await settle()
        expect(await fs.exists('pages', 'A.md')).toBe(true) // still waiting for the write
        gate.release(0)
        await deleting
        await settle()

        expect(await fs.exists('pages', 'A.md')).toBe(false)
        expect(store.listDocuments()).toEqual([])
    })
})

// ── A failed write is reported and retried on demand, never by a timer ─────────────────────────
describe('FilesystemDocumentStore - a write that fails', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** An adapter whose writes throw while `failing.now` is true - a full disk, a lapsed permission. */
    function flakyWrites(fs: DirectoryAdapter, failing: { now: boolean }): DirectoryAdapter {
        return {
            ...fs,
            write: async (subdir, name, text) => {
                if (failing.now) throw new DOMException('The disk is full.', 'QuotaExceededError')
                return fs.write(subdir, name, text)
            },
        }
    }

    it('keeps the buffer dirty, reports the failure, rejects nothing, and flush retries it', async () => {
        const unhandled = vi.fn()
        process.on('unhandledRejection', unhandled)
        try {
            const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
            const failing = { now: true }
            const errors: Array<[string, unknown]> = []
            const store = createFilesystemDocumentStore(flakyWrites(fs, failing), {
                autosaveMs: 10,
                onSaveError: (concept, error) => errors.push([concept, error]),
            })
            await store.scan()
            const doc = store.open('A')
            await flushMicrotasks()

            doc.applyChange({ from: 1, to: 1, insert: 'X' })
            await vi.advanceTimersByTimeAsync(10) // the autosave fails
            expect(errors).toHaveLength(1)
            expect(errors[0][0]).toBe('A')
            expect((errors[0][1] as Error).name).toBe('QuotaExceededError')
            expect((await fs.read('pages', 'A.md')).text).toBe('a')

            // Flush resolves while the disk still refuses, and says so again.
            await expect(store.flushDocument('A')).resolves.toBeUndefined()
            expect(errors).toHaveLength(2)

            // Nothing retries on its own: a full disk is not hammered.
            failing.now = false
            await vi.advanceTimersByTimeAsync(5000)
            expect((await fs.read('pages', 'A.md')).text).toBe('a')

            // The buffer stayed dirty, so the retry writes it once the disk allows.
            await store.flushDocument('A')
            expect((await fs.read('pages', 'A.md')).text).toBe('aX')
            expect(errors).toHaveLength(2)

            await vi.advanceTimersByTimeAsync(0)
            expect(unhandled).not.toHaveBeenCalled()
        } finally {
            process.off('unhandledRejection', unhandled)
        }
    })

    // A check that reads the folder (the orphan scan, the delete's protected read) must not
    // believe a folder whose latest edits could not be written: flushAll says so.
    it('flushAll rejects while a buffer could not be written, naming it, and resolves once it can', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a', 'B.md': 'b' } } })
        const failing = { now: true }
        const store = createFilesystemDocumentStore(flakyWrites(fs, failing), { autosaveMs: 400, onSaveError: () => {} })
        await store.scan()
        const doc = store.open('A')
        store.open('B')
        await flushMicrotasks()
        doc.applyChange({ from: 1, to: 1, insert: 'X' })

        await expect(store.flushAll()).rejects.toThrow('A')
        failing.now = false
        await expect(store.flushAll()).resolves.toBeUndefined()
        expect((await fs.read('pages', 'A.md')).text).toBe('aX')
    })

    it('the next keystroke re-arms the autosave, which retries the whole buffer', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const failing = { now: true }
        const store = createFilesystemDocumentStore(flakyWrites(fs, failing), { autosaveMs: 10, onSaveError: () => {} })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()

        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10) // fails
        failing.now = false
        doc.applyChange({ from: 2, to: 2, insert: 'Y' })
        await vi.advanceTimersByTimeAsync(10)

        expect((await fs.read('pages', 'A.md')).text).toBe('aXY')
    })

    it('dispose writes a dirty buffer whose earlier save failed, once the disk allows', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'a' } } })
        const failing = { now: true }
        const store = createFilesystemDocumentStore(flakyWrites(fs, failing), { autosaveMs: 10, onSaveError: () => {} })
        await store.scan()
        const doc = store.open('A')
        await flushMicrotasks()

        doc.applyChange({ from: 1, to: 1, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10) // fails; the debounce is spent
        failing.now = false
        await store.dispose()

        expect((await fs.read('pages', 'A.md')).text).toBe('aX')
    })
})

// ── A file that exists but could not be read at open ───────────────────────────────────────────
describe('FilesystemDocumentStore - hydration failure on a file that exists', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** An adapter whose reads throw while `unreadable.now` is true - a lock, a sync tool mid-write. */
    function flakyReads(fs: DirectoryAdapter, unreadable: { now: boolean }): DirectoryAdapter {
        return {
            ...fs,
            read: async (subdir, name) => {
                if (unreadable.now) throw new DOMException('The file is locked.', 'NotReadableError')
                return fs.read(subdir, name)
            },
        }
    }

    it('refuses to save over the file, reports it, and a reconcile pass offers the choice', async () => {
        // The empty stand-in buffer used to be saved by the first keystroke: a document
        // replaced by one character.
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'precious' } } })
        const unreadable = { now: false }
        const errors: string[] = []
        const conflicts: DocumentConflict[] = []
        const store = createFilesystemDocumentStore(flakyReads(fs, unreadable), {
            autosaveMs: 10,
            onSaveError: (concept) => errors.push(concept),
            onConflict: (c) => conflicts.push(c),
        })
        await store.scan() // the scan read the file fine
        unreadable.now = true
        const doc = store.open('A')
        await store.whenReady('A') // resolves, with the buffer still empty

        doc.applyChange({ from: 0, to: 0, insert: 'X' })
        await vi.advanceTimersByTimeAsync(10)

        expect((await fs.read('pages', 'A.md')).text).toBe('precious') // never written over
        expect(errors).toEqual(['A'])

        // The file becomes readable: the poll's reconcile reads it and, because something was
        // typed, asks rather than picking a side.
        unreadable.now = false
        await store.reconcile()
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0]).toMatchObject({ target: 'A', diskText: 'precious', bufferText: 'X' })

        await store.resolveConflict('A', 'take-disk')
        expect(doc.getText()).toBe('precious')
        doc.applyChange({ from: 8, to: 8, insert: '!' })
        await vi.advanceTimersByTimeAsync(10)
        expect((await fs.read('pages', 'A.md')).text).toBe('precious!') // saving works again
    })

    it('reloads the buffer on the next reconcile when nothing was typed', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': 'precious' } } })
        const unreadable = { now: false }
        const store = createFilesystemDocumentStore(flakyReads(fs, unreadable), { autosaveMs: 10 })
        await store.scan()
        unreadable.now = true
        const doc = store.open('A')
        await store.whenReady('A')
        expect(doc.getText()).toBe('')

        unreadable.now = false
        await store.reconcile()

        expect(doc.getText()).toBe('precious')
    })

    it('still treats a file that is simply gone as an empty document the first keystroke recreates', async () => {
        // Removed between the scan and the open: there is nothing to protect, and ADR 0039 §4
        // says an edit brings a document back.
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Gone.md': 'x' } } })
        const store = createFilesystemDocumentStore(fs, { autosaveMs: 10 })
        await store.scan()
        await fs.remove('pages', 'Gone.md')
        const doc = store.open('Gone')
        await store.whenReady('Gone')

        doc.applyChange({ from: 0, to: 0, insert: 'back' })
        await vi.advanceTimersByTimeAsync(10)

        expect((await fs.read('pages', 'Gone.md')).text).toBe('back')
    })
})

describe('FilesystemDocumentStore - the registry rescan reads only what moved', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** Record which files the store opens, so a pass can be shown to have read nothing. */
    function countingReads(fs: DirectoryAdapter): { adapter: DirectoryAdapter; reads: string[] } {
        const reads: string[] = []
        const adapter: DirectoryAdapter = {
            ...fs,
            read: async (subdir, name) => {
                reads.push(`${subdir}/${name}`)
                return fs.read(subdir, name)
            },
        }
        return { adapter, reads }
    }

    it('a reconcile pass over an unchanged graph reads no file at all', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { journals: { '2026-09-22.md': '- today' }, pages: { 'A.md': 'a', 'B.md': 'b' } },
        })
        const { adapter, reads } = countingReads(fs)
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        expect(reads).toHaveLength(3) // graph open learns every identity

        reads.length = 0
        await store.reconcile()
        await store.reconcile()
        expect(reads).toEqual([])
    })

    it('a document whose own write is in flight is not read by the pass, before or after the write settles', async () => {
        // On Windows a read handle held by the app itself makes the browser's rename of the swap
        // file over the target fail, so the pass must not open a file the store is writing.
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Kanban.md': '- [ ] task' } } })
        const { adapter, reads } = countingReads(fs)
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        const slow: DirectoryAdapter = {
            ...adapter,
            // Land the bytes (a listing now reports the new stamps), then hold the acknowledgement.
            write: async (subdir, name, text) => {
                const res = await adapter.write(subdir, name, text)
                await gate
                return res
            },
        }
        const store = createFilesystemDocumentStore(slow, { autosaveMs: 10 })
        await store.scan()
        const doc = store.open('Kanban')
        await flushMicrotasks()
        reads.length = 0

        doc.applyChange({ from: 3, to: 4, insert: 'x' })
        await vi.advanceTimersByTimeAsync(20) // the write is in flight
        const reconciling = store.reconcile()
        await flushMicrotasks()
        expect(reads).toEqual([]) // the scan reused the entry rather than opening the file
        release()
        await reconciling

        expect(reads).toEqual([])
        expect(doc.getText()).toBe('- [x] task')
        // The entry carries the write's stamps, so the next pass has nothing to read either.
        const onDisk = await fs.read('pages', 'Kanban.md')
        expect(store.listDocuments().find((e) => e.key === 'kanban')).toMatchObject({ lastModified: onDisk.lastModified, size: onDisk.size })
        await store.reconcile()
        expect(reads).toEqual([])
    })

    it('a title edited outside the app with the same mtime and size is seen once the stamps move, not before', async () => {
        // The accepted blind spot of keying on (mtime, size): a same-length edit inside the
        // timestamp's resolution, or by a tool that preserves mtime. Documented in
        // Filesystem Backend → Reconciliation.
        let t = 5000
        const fs = createMemoryDirectoryAdapter({ now: () => t, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()

        await fs.write('pages', 'Plan.md', '---\ntitle: Play\n---\n') // same length, same stamp
        await store.reconcile()
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['Plan'])

        t = 6000
        await fs.write('pages', 'Plan.md', '---\ntitle: Play\n---\n')
        await store.reconcile()
        expect(store.listDocuments().map((e) => e.concept)).toEqual(['Play'])
    })
})
