import { describe, expect, it } from 'vitest'

import { addBookmark, getBookmarks, resetBookmarks, setBookmarks } from '$lib/document/bookmarks/bookmarks'

import {
    BOOKMARKS_FILE,
    BookmarksFileUnreadableError,
    bookmarksFileBinding,
    bookmarksFileText,
    readBookmarks,
    writeBookmarks,
} from './bookmarks-file'
import type { DirectoryAdapter } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'

const clock = () => {
    let t = 1000
    return () => (t += 1)
}

const garden = { id: 'a', concept: 'Garden', line: 2, text: 'water the beans', before: 'Garden', createdAt: 100 }

describe('bookmarks file', () => {
    it('reads no bookmarks when the file is absent', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        expect(await readBookmarks(adapter)).toEqual([])
    })

    it('writes etherpk/bookmarks.json and round-trips', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeBookmarks(adapter, [garden])

        expect((await adapter.list('etherpk')).map((e) => e.name)).toEqual([BOOKMARKS_FILE])
        expect(BOOKMARKS_FILE).toBe('bookmarks.json')
        expect((await adapter.read('etherpk', BOOKMARKS_FILE)).text.endsWith('\n')).toBe(true)
        expect(await readBookmarks(adapter)).toEqual([garden])
    })

    it('writes only well-formed bookmarks, pretty-printed', () => {
        const text = bookmarksFileText([garden, { id: 'b' } as never])
        expect(JSON.parse(text)).toEqual([garden])
        expect(text).toContain('\n  {')
    })

    it('refuses a file that is not a JSON array, so nothing writes over the person’s bookmarks', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', BOOKMARKS_FILE, '{not json')
        await expect(readBookmarks(adapter)).rejects.toBeInstanceOf(BookmarksFileUnreadableError)
        await adapter.write('etherpk', BOOKMARKS_FILE, '{"id": "a"}')
        await expect(readBookmarks(adapter)).rejects.toThrow('etherpk/bookmarks.json')
    })

    it('drops a malformed entry in an otherwise readable file', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', BOOKMARKS_FILE, JSON.stringify([garden, { id: 'b', concept: 'Kitchen' }]))
        expect(await readBookmarks(adapter)).toEqual([garden])
    })

    it('refuses a file that exists but cannot be read (a revoked permission), rather than reading it as absent', async () => {
        const memory = createMemoryDirectoryAdapter({ now: clock() })
        await writeBookmarks(memory, [garden])
        const locked: DirectoryAdapter = {
            ...memory,
            read: async () => {
                throw new DOMException('The request is not allowed.', 'NotAllowedError')
            },
        }
        await expect(readBookmarks(locked)).rejects.toBeInstanceOf(BookmarksFileUnreadableError)
    })
})

describe('bookmarksFileBinding: the bookmarks a folder graph opens with, and how they are saved', () => {
    it('reads the file and writes each change back whole', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await writeBookmarks(adapter, [garden])
        const binding = await bookmarksFileBinding(adapter)
        expect(binding.problem).toBeUndefined()
        setBookmarks(binding.bookmarks, binding.persist)
        await addBookmark('Kitchen', { line: 0, text: 'buy flour' })
        expect((await readBookmarks(adapter)).map((b) => b.concept)).toEqual(['Garden', 'Kitchen'])
        resetBookmarks()
    })

    it('opens with no bookmarks, names the file in its problem, and refuses every write when the file is unreadable', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', BOOKMARKS_FILE, '{not json')
        const binding = await bookmarksFileBinding(adapter)
        expect(binding.bookmarks).toEqual([])
        expect(binding.problem).toContain('etherpk/bookmarks.json')
        setBookmarks(binding.bookmarks, binding.persist)
        await expect(addBookmark('Kitchen', { line: 0, text: 'buy flour' })).rejects.toThrow('etherpk/bookmarks.json')
        expect(getBookmarks()).toEqual([])
        expect((await adapter.read('etherpk', BOOKMARKS_FILE)).text).toBe('{not json')
        resetBookmarks()
    })
})
