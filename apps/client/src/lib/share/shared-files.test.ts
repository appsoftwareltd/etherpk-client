import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'

import { SHARED_FILES_MAX_AGE_MS, forgetSharedFiles, keepSharedFiles, readSharedFiles } from './shared-files'

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('etherpk-shared-files')
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
    })
})

const text = (file: File) => file.text()

describe('shared files', () => {
    it('keeps the files of a share under an id and reads them back as they arrived', async () => {
        const id = await keepSharedFiles([
            new File(['a receipt'], 'receipt.png', { type: 'image/png', lastModified: 5 }),
            new File(['a report'], 'report.pdf', { type: 'application/pdf', lastModified: 6 }),
        ])

        const files = await readSharedFiles(id)

        expect(files.map((file) => [file.name, file.type, file.lastModified])).toEqual([
            ['receipt.png', 'image/png', 5],
            ['report.pdf', 'application/pdf', 6],
        ])
        expect(await Promise.all(files.map(text))).toEqual(['a receipt', 'a report'])
    })

    it('reads nothing for an id that names no share, and nothing once a share is forgotten', async () => {
        expect(await readSharedFiles('no-such-share')).toEqual([])
        const id = await keepSharedFiles([new File(['x'], 'x.txt')])
        await forgetSharedFiles(id)
        expect(await readSharedFiles(id)).toEqual([])
    })

    it('removes a share older than a day when the next one is kept', async () => {
        const old = await keepSharedFiles([new File(['old'], 'old.txt')], { now: 1_000 })
        const recent = await keepSharedFiles([new File(['recent'], 'recent.txt')], { now: 1_000 + SHARED_FILES_MAX_AGE_MS - 1 })
        await keepSharedFiles([new File(['new'], 'new.txt')], { now: 1_000 + SHARED_FILES_MAX_AGE_MS + 1 })
        expect(await readSharedFiles(old)).toEqual([])
        expect(await readSharedFiles(recent)).toHaveLength(1)
    })
})
