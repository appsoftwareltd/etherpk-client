import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from './memory-adapter'
import { QUICK_NOTES_FILE, readQuickNotes, writeQuickNotes } from './quick-notes-file'

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
