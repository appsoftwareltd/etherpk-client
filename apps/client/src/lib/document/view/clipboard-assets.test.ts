import { describe, expect, it } from 'vitest'

import { clipboardAssetFiles, isGenericClipboardName, nameClipboardFile, readClipboardImages } from './clipboard-assets'

/** A `navigator.clipboard.read()` stand-in: items whose `getType` hands back blobs. */
function fakeClipboard(items: Array<Record<string, Blob>>, error?: Error) {
    return {
        async read() {
            if (error) throw error
            return items.map((blobs) => ({
                types: Object.keys(blobs),
                getType: async (type: string) => blobs[type],
            })) as unknown as ClipboardItems
        },
    }
}

describe('readClipboardImages: the Paste button for touch devices', () => {
    const now = new Date(2026, 8, 2, 14, 32, 8)

    it('turns each image item into a timestamp-named File, preferring PNG', async () => {
        const png = new Blob([new Uint8Array([1])], { type: 'image/png' })
        const jpeg = new Blob([new Uint8Array([2])], { type: 'image/jpeg' })
        const files = await readClipboardImages(fakeClipboard([{ 'text/html': new Blob(['<img>']), 'image/jpeg': jpeg, 'image/png': png }]), now)
        expect(files.map((f) => f.name)).toEqual(['image-2026-09-02-14-32-08.png'])
        expect(files[0].type).toBe('image/png')
    })

    it('returns nothing for a text-only clipboard', async () => {
        expect(await readClipboardImages(fakeClipboard([{ 'text/plain': new Blob(['hi']) }]), now)).toEqual([])
    })

    it('surfaces a permission refusal as a ClipboardAccessRefused error the dialog can word', async () => {
        const denied = new DOMException('Read permission denied.', 'NotAllowedError')
        await expect(readClipboardImages(fakeClipboard([], denied), now)).rejects.toMatchObject({ name: 'ClipboardAccessRefused' })
    })
})

/** A clipboard payload shaped like `DataTransfer` without needing the DOM. */
function clipboard(files: File[], types: string[]) {
    return { files, types }
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })

describe('clipboardAssetFiles: files win only when there is no plain text', () => {
    it('returns the files for a screenshot paste (files, no text/plain)', () => {
        const file = png()
        expect(clipboardAssetFiles(clipboard([file], ['Files']))).toEqual([file])
    })

    it('returns the files for an image copied from a web page (files + text/html, no text/plain)', () => {
        const file = png()
        expect(clipboardAssetFiles(clipboard([file], ['text/html', 'Files']))).toEqual([file])
    })

    it('falls through (empty) when plain text is present alongside files - a spreadsheet selection', () => {
        expect(clipboardAssetFiles(clipboard([png()], ['text/plain', 'text/html', 'Files']))).toEqual([])
    })

    it('falls through when there are no files at all', () => {
        expect(clipboardAssetFiles(clipboard([], ['text/plain']))).toEqual([])
        expect(clipboardAssetFiles(null)).toEqual([])
        expect(clipboardAssetFiles(undefined)).toEqual([])
    })

    it('keeps clipboard order for a multi-file paste', () => {
        const a = new File([new Uint8Array(1)], 'a.pdf', { type: 'application/pdf' })
        const b = new File([new Uint8Array(1)], 'b.pdf', { type: 'application/pdf' })
        expect(clipboardAssetFiles(clipboard([a, b], ['Files'])).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf'])
    })
})

describe('nameClipboardFile: unnamed clipboard files get a timestamp name', () => {
    const now = new Date(2026, 8, 2, 14, 32, 8) // local time, 2 Sep 2026 14:32:08

    it('names a Chrome screenshot ("image.png") image-YYYY-MM-DD-HH-MM-SS.png', () => {
        const named = nameClipboardFile(png(), now)
        expect(named.name).toBe('image-2026-09-02-14-32-08.png')
        expect(named.type).toBe('image/png')
    })

    it('names a nameless non-image file-YYYY-MM-DD-HH-MM-SS.<ext from MIME>', () => {
        const pdf = new File([new Uint8Array(1)], '', { type: 'application/pdf' })
        expect(nameClipboardFile(pdf, now).name).toBe('file-2026-09-02-14-32-08.pdf')
    })

    it('takes the extension from the MIME type when the name has none', () => {
        const jpeg = new File([new Uint8Array(1)], 'image', { type: 'image/jpeg' })
        expect(nameClipboardFile(jpeg, now).name).toBe('image-2026-09-02-14-32-08.jpg')
    })

    it('falls back to .bin when neither the name nor the MIME type says what it is', () => {
        const blob = new File([new Uint8Array(1)], 'blob', { type: '' })
        expect(nameClipboardFile(blob, now).name).toBe('file-2026-09-02-14-32-08.bin')
    })

    it('keeps a real file name exactly as drag-and-drop would', () => {
        const report = new File([new Uint8Array(1)], 'Q3 Report.pdf', { type: 'application/pdf' })
        expect(nameClipboardFile(report, now)).toBe(report)
    })

    it('zero-pads every field of the stamp', () => {
        const early = new Date(2026, 0, 5, 3, 4, 9)
        expect(nameClipboardFile(png(), early).name).toBe('image-2026-01-05-03-04-09.png')
    })

    it('recognises the generic names browsers hand over', () => {
        for (const name of ['', 'image.png', 'image.jpeg', 'image', 'blob', 'file', 'clipboard.png']) {
            expect(isGenericClipboardName(name), name).toBe(true)
        }
        for (const name of ['holiday.png', 'image-of-cat.png', 'Q3 Report.pdf', 'blob-store-notes.md']) {
            expect(isGenericClipboardName(name), name).toBe(false)
        }
    })
})
