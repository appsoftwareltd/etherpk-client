import { describe, expect, it } from 'vitest'

import { carriesFiles, dropRefusal, droppedHandle, isMarkdownFileName } from './dropped-entry'

const handle = (kind: 'file' | 'directory', name: string) => ({ kind, name }) as unknown as FileSystemHandle
const item = (kind: string, found?: FileSystemHandle | null | Error) => ({
    kind,
    ...(found === undefined ? {} : { getAsFileSystemHandle: () => (found instanceof Error ? Promise.reject(found) : Promise.resolve(found)) }),
})
const transfer = (items: unknown[], types = ['Files']) => ({ items, types }) as unknown as DataTransfer

describe('what was dropped onto the app', () => {
    it('is the first folder, else the first file', async () => {
        const folder = handle('directory', 'garden')
        const file = handle('file', 'watering.md')
        expect(await droppedHandle(transfer([item('string'), item('file', file), item('file', folder)]))).toBe(folder)
        expect(await droppedHandle(transfer([item('file', file), item('file', handle('file', 'soil.md'))]))).toBe(file)
    })

    it('is nothing where the browser gives no handles, or a handle cannot be had', async () => {
        expect(await droppedHandle(transfer([item('file')]))).toBeNull()
        expect(await droppedHandle(transfer([item('file', new Error('gone')), item('file', null)]))).toBeNull()
        expect(await droppedHandle(null)).toBeNull()
    })

    it('says why a drop is not opened, and nothing for a folder or a markdown file', () => {
        expect(dropRefusal(handle('directory', 'garden'))).toBeNull()
        expect(dropRefusal(handle('file', 'watering.md'))).toBeNull()
        expect(dropRefusal(handle('file', 'bed.png'))).toBe('EtherPK opens a folder or a markdown file dropped here. bed.png is neither.')
        expect(dropRefusal(null)).toContain('does not hand over what was dropped')
    })

    it('knows a drag from the file manager, and a markdown file by its name', () => {
        expect(carriesFiles(transfer([], ['Files', 'text/plain']))).toBe(true)
        expect(carriesFiles(transfer([], ['text/plain']))).toBe(false)
        expect(carriesFiles(null)).toBe(false)
        expect(['a.md', 'A.MARKDOWN', 'notes.txt', 'md'].map(isMarkdownFileName)).toEqual([true, true, false, false])
    })
})
