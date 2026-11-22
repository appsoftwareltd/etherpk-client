import { describe, expect, it } from 'vitest'

import { isNotFound } from './folder-tree-adapter'
import { createPlainFolderStore } from './plain-folder-store'
import { NeedsFolderError, createSingleFileAdapter } from './single-file-adapter'

/** A file handle as the browser hands one over: its own bytes, and nothing about where it is. */
function fileHandle(name: string, text: string) {
    let bytes = new TextEncoder().encode(text)
    let modified = 1000
    const handle = {
        kind: 'file',
        name,
        getFile: async () => new File([bytes], name, { lastModified: modified }),
        createWritable: async () => ({
            write: async (next: Uint8Array<ArrayBuffer>) => {
                bytes = next
                modified += 1000
            },
            close: async () => {},
        }),
    } as unknown as FileSystemFileHandle
    return { handle, text: () => new TextDecoder().decode(bytes) }
}

describe('one file opened on its own', () => {
    it('is the whole of what can be listed, read and found', async () => {
        const tree = createSingleFileAdapter(fileHandle('watering.md', '# Watering\n').handle)
        expect(await tree.list('')).toEqual([{ name: 'watering.md', kind: 'file' }])
        expect(await tree.stat('watering.md')).toMatchObject({ kind: 'file', size: 11 })
        expect(await tree.stat('soil.md')).toBeNull()
        expect(await tree.canonicalPath('watering.md')).toBe('watering.md')
        expect(new TextDecoder().decode((await tree.read('watering.md')).bytes)).toBe('# Watering\n')
        await expect(tree.read('images/bed.png')).rejects.toSatisfy(isNotFound)
        await expect(tree.list('images')).rejects.toSatisfy(isNotFound)
    })

    it('saves the file, and refuses everything beside it with the way to get it', async () => {
        const file = fileHandle('watering.md', '# Watering\n')
        const tree = createSingleFileAdapter(file.handle)
        await tree.write('watering.md', new TextEncoder().encode('# Watering\n\nBeds.\n'))
        expect(file.text()).toBe('# Watering\n\nBeds.\n')

        await expect(tree.write('soil.md', new Uint8Array())).rejects.toThrow(NeedsFolderError)
        await expect(tree.createDirectory('.etherpk')).rejects.toThrow('Open the folder to keep anything beside this file.')
        await expect(tree.remove('watering.md')).rejects.toThrow(NeedsFolderError)
        await expect(tree.move('watering.md', 'hoses.md')).rejects.toThrow(NeedsFolderError)
    })

    it('is edited through the same store a folder’s files are, with the same check before a save', async () => {
        const file = fileHandle('watering.md', 'Beds.\r\nFence.\r\n')
        const store = createPlainFolderStore(createSingleFileAdapter(file.handle), { autosaveMs: 400 })
        const document = store.open('watering.md')
        await store.whenReady('watering.md')
        document.applyChange({ from: 0, to: 4, insert: 'Rows' })
        await store.flushDocument('watering.md')
        expect(file.text()).toBe('Rows.\r\nFence.\r\n')
    })
})
