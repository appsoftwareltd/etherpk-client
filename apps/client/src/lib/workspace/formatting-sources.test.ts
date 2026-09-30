/**
 * The Formatting Scan's source per backend (ADR 0109): what each lists, in what order, and how a
 * read that cannot be trusted or cannot be done comes back.
 */

import { describe, expect, it } from 'vitest'

import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import type { DocumentIdentity, DocumentText } from '$lib/storage/server/server-document-store'

import { filesystemFormattingSource, serverFormattingSource } from './formatting-sources'

const never = new AbortController().signal

function clock(start = 1000) {
    let t = start
    return () => (t += 1000)
}

describe('the synced graph source', () => {
    const identities: DocumentIdentity[] = [
        { docId: 'p-b', kind: 'page', concept: 'Beta', aliases: [] },
        { docId: 'j-1', kind: 'journal', concept: '2026-09-01', aliases: [] },
        { docId: 'p-a', kind: 'page', concept: 'alpha', aliases: [] },
        { docId: 'j-2', kind: 'journal', concept: '2026-09-02', aliases: [] },
    ]
    const texts = new Map<string, DocumentText>([
        ['p-a', { text: '* a', settled: true }],
        ['p-b', { text: 'stale', settled: false }],
    ])
    const store = {
        listIdentities: () => identities,
        readTexts: async (docIds: readonly string[]) => new Map([...texts].filter(([id]) => docIds.includes(id))),
        spliceIfUnchanged: async () => 'written' as const,
    }

    it('lists journals newest first, then pages by name, keyed by document id', async () => {
        const listed = await serverFormattingSource(store).list()
        expect(listed.map((d) => d.key)).toEqual(['j-2', 'j-1', 'p-a', 'p-b'])
        expect(listed[2]).toEqual({ key: 'p-a', concept: 'alpha', kind: 'page' })
    })

    it('reads settled text, and a page the relay could not confirm as still syncing', async () => {
        const reads = await serverFormattingSource(store).read(['p-a', 'p-b', 'gone-id'], never)
        expect(reads.get('p-a')).toEqual({ kind: 'text', text: '* a' })
        expect(reads.get('p-b')).toEqual({ kind: 'unread', reason: 'syncing' })
        expect(reads.get('gone-id')).toEqual({ kind: 'gone' })
    })
})

describe('the folder graph source', () => {
    it('follows the folder before listing, so a file added outside the app is checked', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': '- a' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        await fs.write('pages', 'B.md', '* b')

        const listed = await filesystemFormattingSource(store).list()
        expect(listed.map((d) => d.key)).toEqual(['A', 'B'])
        expect(listed[1]).toEqual({ key: 'B', concept: 'B', kind: 'page' })
    })

    it('reads each whole text, and names a file it could not read', async () => {
        const memory = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': '---\ntitle: A\n---\n* a', 'Locked.md': '- x' } } })
        // A file another program takes hold of after the graph opened: it is there, but reading it fails.
        let locked = false
        const fs: DirectoryAdapter = {
            ...memory,
            read: (subdir, name) => (locked && name === 'Locked.md' ? Promise.reject(new Error('The file is locked')) : memory.read(subdir, name)),
        }
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        locked = true

        const reads = await filesystemFormattingSource(store).read(['A', 'Locked', 'Nowhere'], never)
        expect(reads.get('A')).toEqual({ kind: 'text', text: '---\ntitle: A\n---\n* a' })
        expect(reads.get('Locked')).toEqual({ kind: 'unread', reason: 'unreadable' })
        expect(reads.get('Nowhere')).toEqual({ kind: 'gone' })
    })

    it('stops reading when the scan is cancelled', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'A.md': '- a' } } })
        const store = createFilesystemDocumentStore(fs)
        await store.scan()
        const cancelled = new AbortController()
        cancelled.abort()
        await expect(filesystemFormattingSource(store).read(['A'], cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
    })
})
