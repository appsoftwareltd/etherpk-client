/**
 * The files of an EBook, read from its zip one at a time as each is asked for. An EBook is anyone's file: a small
 * zip can claim to hold gigabytes, so a file past a limit is treated as missing, and only what a page needs is
 * ever inflated. Keeping nothing inflated also holds down the memory a long EBook takes.
 */
import { strFromU8, unzipSync } from 'fflate'

/** Far past any real file in an EBook, and within what a browser can hold. */
export const MAX_EBOOK_FILE_BYTES = 256 * 1024 * 1024

export interface EbookZip {
    entries: { filename: string }[]
    loadText(name: string): string | null
    loadBlob(name: string, type?: string): Blob | null
    getSize(name: string): number
    has(name: string): boolean
}

export function openEbookZip(bytes: Uint8Array): EbookZip {
    const sizes = new Map<string, number>()
    unzipSync(bytes, {
        filter(file) {
            sizes.set(file.name, file.originalSize)
            return false
        },
    })
    const inflate = (name: string): Uint8Array | null => {
        const size = sizes.get(name)
        if (size === undefined || size > MAX_EBOOK_FILE_BYTES) return null
        return unzipSync(bytes, { filter: (file) => file.name === name })[name] ?? null
    }
    return {
        entries: [...sizes.keys()].map((filename) => ({ filename })),
        loadText(name) {
            const file = inflate(name)
            return file ? strFromU8(file) : null
        },
        loadBlob(name, type) {
            const file = inflate(name)
            return file ? new Blob([file as BlobPart], type ? { type } : {}) : null
        },
        getSize: (name) => sizes.get(name) ?? 0,
        has: (name) => sizes.has(name),
    }
}
