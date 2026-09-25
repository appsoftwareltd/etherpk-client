/**
 * A zip reader over a random-access source, for [[Import]] from a zip (ADR 0092).
 *
 * The central directory sits at the end of an archive and names every entry with its offset,
 * so listing costs one read of the tail and reading an entry costs one read of its bytes. A
 * `File` from the picker is such a source through `slice()`, which is what lets a multi-gigabyte
 * export be imported without ever loading it whole. zip64 end records are followed when present,
 * and an entry's sizes come from the central directory, so an archive written with data
 * descriptors reads the same as one without.
 */

import { inflateSync } from 'fflate'

import { crc32 } from './crc32'

export interface RandomAccessSource {
    readonly size: number
    /** `length` bytes from `offset`; fewer only at the end of the source. */
    read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipEntry {
    /** The name as stored, `/`-separated. */
    path: string
    /** A directory record: no data, a trailing slash. */
    directory: boolean
    /** 0 stored, 8 deflated; anything else this reader refuses to read. */
    method: number
    size: number
    compressedSize: number
    crc: number
    localHeaderOffset: number
    /** True when the entry is encrypted (general purpose bit 0). Refused on read. */
    encrypted: boolean
}

const END_SIGNATURE = 0x06054b50
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const MAX_32 = 0xffffffff
const MAX_16 = 0xffff
/** The end record is 22 bytes plus a comment of at most 65535. */
const END_SEARCH_LENGTH = 22 + MAX_16
const decoder = new TextDecoder()

export function bytesSource(bytes: Uint8Array): RandomAccessSource {
    return {
        size: bytes.length,
        async read(offset, length) {
            return bytes.subarray(offset, Math.min(bytes.length, offset + length))
        },
    }
}

export function blobSource(blob: Blob): RandomAccessSource {
    return {
        size: blob.size,
        async read(offset, length) {
            return new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer())
        },
    }
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u64(view: DataView, at: number): number {
    const value = view.getBigUint64(at, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip: a size or offset is too large to address')
    return Number(value)
}

interface Directory {
    entries: number
    size: number
    offset: number
}

/** Find the end record, and through it the central directory's place and length. */
async function locateDirectory(source: RandomAccessSource): Promise<Directory> {
    const tailLength = Math.min(source.size, END_SEARCH_LENGTH)
    const tailOffset = source.size - tailLength
    const tail = await source.read(tailOffset, tailLength)
    const view = viewOf(tail)
    let at = -1
    for (let i = tail.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === END_SIGNATURE) {
            at = i
            break
        }
    }
    if (at < 0) throw new Error('not a zip file: no end of central directory record')
    const directory: Directory = {
        entries: view.getUint16(at + 10, true),
        size: view.getUint32(at + 12, true),
        offset: view.getUint32(at + 16, true),
    }
    const overflowed = directory.entries === MAX_16 || directory.size === MAX_32 || directory.offset === MAX_32
    const locatorAt = at - 20
    const hasLocator = locatorAt >= 0 && view.getUint32(locatorAt, true) === ZIP64_LOCATOR_SIGNATURE
    if (!overflowed && !hasLocator) return directory
    if (!hasLocator) throw new Error('zip: the end record needs a zip64 record and there is no locator for it')
    const zip64EndOffset = u64(view, locatorAt + 8)
    const record = await source.read(zip64EndOffset, 56)
    const recordView = viewOf(record)
    if (record.length < 56 || recordView.getUint32(0, true) !== ZIP64_END_SIGNATURE) {
        throw new Error('zip: the zip64 end record is not where the locator says')
    }
    return {
        entries: u64(recordView, 32),
        size: u64(recordView, 40),
        offset: u64(recordView, 48),
    }
}

/** Every entry of the archive, from its central directory. */
export async function readZipDirectory(source: RandomAccessSource): Promise<ZipEntry[]> {
    const directory = await locateDirectory(source)
    const bytes = await source.read(directory.offset, directory.size)
    if (bytes.length < directory.size) throw new Error('zip: the central directory is cut short')
    const view = viewOf(bytes)
    const entries: ZipEntry[] = []
    let at = 0
    for (let n = 0; n < directory.entries; n++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_HEADER_SIGNATURE) {
            throw new Error('zip: a central directory record is malformed')
        }
        const flags = view.getUint16(at + 8, true)
        const method = view.getUint16(at + 10, true)
        const crc = view.getUint32(at + 16, true)
        let compressedSize = view.getUint32(at + 20, true)
        let size = view.getUint32(at + 24, true)
        const nameLength = view.getUint16(at + 28, true)
        const extraLength = view.getUint16(at + 30, true)
        const commentLength = view.getUint16(at + 32, true)
        let localHeaderOffset = view.getUint32(at + 42, true)
        const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
        // The zip64 extra lists, in order, only the fields whose fixed slot overflowed.
        let extraAt = at + 46 + nameLength
        const extraEnd = extraAt + extraLength
        while (extraAt + 4 <= extraEnd) {
            const id = view.getUint16(extraAt, true)
            const length = view.getUint16(extraAt + 2, true)
            if (id === ZIP64_EXTRA_ID) {
                let field = extraAt + 4
                if (size === MAX_32) {
                    size = u64(view, field)
                    field += 8
                }
                if (compressedSize === MAX_32) {
                    compressedSize = u64(view, field)
                    field += 8
                }
                if (localHeaderOffset === MAX_32) localHeaderOffset = u64(view, field)
            }
            extraAt += 4 + length
        }
        entries.push({
            path,
            directory: path.endsWith('/'),
            method,
            size,
            compressedSize,
            crc,
            localHeaderOffset,
            encrypted: (flags & 0x0001) !== 0,
        })
        at += 46 + nameLength + extraLength + commentLength
    }
    return entries
}

/**
 * Where a stored entry's bytes sit in the source, so a caller can slice them lazily rather than
 * read them: an export's attachments are stored, and this is what lets an import keep them as
 * slices of the picked file.
 */
export async function zipEntryDataRange(source: RandomAccessSource, entry: ZipEntry): Promise<{ start: number; end: number }> {
    if (entry.method !== 0) throw new Error(`"${entry.path}" is not a stored entry`)
    const start = await dataStart(source, entry)
    return { start, end: start + entry.compressedSize }
}

async function dataStart(source: RandomAccessSource, entry: ZipEntry): Promise<number> {
    const header = await source.read(entry.localHeaderOffset, 30)
    const view = viewOf(header)
    if (header.length < 30 || view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`zip: the local header of "${entry.path}" is not where the directory says`)
    }
    return entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
}

/** One entry's bytes, inflated when deflated and checked against its CRC. */
export async function readZipEntry(source: RandomAccessSource, entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
    if (entry.encrypted) throw new Error(`"${entry.path}" is encrypted, which is not supported`)
    if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`"${entry.path}" uses compression method ${entry.method}, which is not supported`)
    }
    const start = await dataStart(source, entry)
    const raw = await source.read(start, entry.compressedSize)
    if (raw.length < entry.compressedSize) throw new Error(`zip: "${entry.path}" is cut short`)
    const bytes = entry.method === 8 ? inflateSync(raw) : new Uint8Array(raw)
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
        throw new Error(`zip: "${entry.path}" failed its CRC check`)
    }
    return bytes
}
