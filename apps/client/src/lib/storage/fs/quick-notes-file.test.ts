import { describe, expect, it } from 'vitest'

import type { DirectoryAdapter } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import { QUICK_NOTES_FILE, quickNotesFilePersist, readQuickNotes, writeQuickNotes } from './quick-notes-file'

const clock = () => {
    let t = 1000
    return () => (t += 1)
}

describe('quick notes file', () => {
    it('reads no notes when the file is absent', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        expect(await readQuickNotes(adapter)).toEqual([])
    })

    it('writes etherpk/quick-notes.json and round-trips', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const notes = [{ id: 'a', text: 'Ring the dentist', createdAt: 100 }]
        await writeQuickNotes(adapter, notes)

        expect((await adapter.list('etherpk')).map((e) => e.name)).toEqual([QUICK_NOTES_FILE])
        expect((await adapter.read('etherpk', QUICK_NOTES_FILE)).text.endsWith('\n')).toBe(true)
        expect(await readQuickNotes(adapter)).toEqual(notes)
    })

    it('reads a malformed file as no notes rather than failing the open', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        await adapter.write('etherpk', QUICK_NOTES_FILE, '{not json')
        expect(await readQuickNotes(adapter)).toEqual([])
        await adapter.write('etherpk', QUICK_NOTES_FILE, '[{"id":"a","text":"ok","createdAt":1},{"id":"b"}]')
        expect(await readQuickNotes(adapter)).toEqual([{ id: 'a', text: 'ok', createdAt: 1 }])
    })
})

describe('the list kept in the file', () => {
    const at = (id: string, createdAt: number) => ({ id, text: id, createdAt })
    const ids = async (adapter: DirectoryAdapter) => (await readQuickNotes(adapter)).map((held) => held.id).sort()

    it('writes each change over the one before, in order, however they overlap', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const kept = quickNotesFilePersist(adapter, [at('a', 1)])
        await Promise.all([kept.add(at('b', 2)), kept.add(at('c', 3)), kept.remove(['a'])])
        expect(await ids(adapter)).toEqual(['b', 'c'])
    })

    it('a refused write leaves nothing behind for the next one to save', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const write = adapter.write.bind(adapter)
        let refuse = true
        adapter.write = async (...args) => {
            if (refuse) throw new Error('the disk is full')
            return write(...args)
        }
        const kept = quickNotesFilePersist(adapter, [at('a', 1)])
        await expect(kept.add(at('b', 2))).rejects.toThrow('the disk is full')
        await expect(kept.remove(['a'])).rejects.toThrow('the disk is full')
        refuse = false
        await kept.add(at('c', 3))
        expect(await ids(adapter)).toEqual(['a', 'c'])
    })
})
