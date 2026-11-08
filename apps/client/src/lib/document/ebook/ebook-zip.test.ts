import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { MAX_EBOOK_FILE_BYTES, openEbookZip } from './ebook-zip'

describe('reading an EBook\'s zip', () => {
    const zip = openEbookZip(zipSync({ 'OEBPS/a.xhtml': strToU8('beans'), 'OEBPS/b.png': new Uint8Array([1, 2, 3]) }))

    it('lists its files and says how big each is', () => {
        expect(zip.entries.map((entry) => entry.filename).sort()).toEqual(['OEBPS/a.xhtml', 'OEBPS/b.png'])
        expect(zip.getSize('OEBPS/a.xhtml')).toBe(5)
        expect(zip.getSize('nothing')).toBe(0)
    })

    it('reads a file as text or as a blob of the type asked for', async () => {
        expect(zip.loadText('OEBPS/a.xhtml')).toBe('beans')
        const blob = zip.loadBlob('OEBPS/b.png', 'image/png')
        expect(blob?.type).toBe('image/png')
        expect(blob?.size).toBe(3)
    })

    it('answers null for a file it does not hold', () => {
        expect(zip.loadText('nothing')).toBeNull()
        expect(zip.loadBlob('nothing')).toBeNull()
    })

    it('treats a file that claims to be enormous as missing, and inflates none of it', () => {
        const bytes = zipSync({ 'OEBPS/huge.xhtml': strToU8('beans') })
        // The original size in the central directory, which a zip bomb lies about. Found by its signature.
        const view = new DataView(bytes.buffer)
        let at = bytes.length - 22
        while (view.getUint32(at, true) !== 0x06054b50) at--
        const central = view.getUint32(at + 16, true)
        view.setUint32(central + 24, MAX_EBOOK_FILE_BYTES + 1, true)
        const bomb = openEbookZip(bytes)
        expect(bomb.has('OEBPS/huge.xhtml')).toBe(true)
        expect(bomb.loadText('OEBPS/huge.xhtml')).toBeNull()
    })
})
