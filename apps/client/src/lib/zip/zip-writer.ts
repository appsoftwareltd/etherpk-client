/**
 * A streaming zip writer with zip64, for an [[Export]] of any size (ADR 0092).
 *
 * `fflate` zips a [[Published Site]] in one buffer and cannot write zip64, which caps an archive
 * at 4 GB; a graph can hold more. This writer emits each entry as it is added - local header,
 * then data - through a sink that never sees the whole archive, and writes the central directory
 * on close. Sizes and CRC are known before each local header (the bytes are in hand), so no data
 * descriptors are needed and every entry is complete the moment its data has gone out.
 *
 * zip64 records are written only when a size, an offset or the entry count needs them (or when
 * forced, which the tests use), so a small archive stays the plain format every tool reads.
 * Names are UTF-8 with the language flag set. Deflate is `fflate`'s, per entry, for text;
 * attachments are already compressed media and are stored.
 */

import { deflateSync, strToU8 } from 'fflate'

import { crc32 } from './crc32'

export interface ZipSink {
    /** Take the next bytes of the archive. Resolving is the writer's backpressure. */
    write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
}

export interface ZipAddOptions {
    /** Deflate the entry (text); attachments are stored as they are. */
    compress?: boolean
    /** The entry's modification time, epoch ms. Defaults to the writer's clock. */
    mtime?: number
}

export interface ZipWriterOptions {
    now?: () => number
    /** Write zip64 records for every entry and the end records regardless of size. Tests. */
    forceZip64?: boolean
    /** Deflate level, 0-9. */
    level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

export interface ZipWriter {
    /** Append one entry. Concurrent calls are written in call order. */
    add(path: string, bytes: Uint8Array, options?: ZipAddOptions): Promise<void>
    /** Write the central directory and end records. Nothing can be added afterwards. */
    close(): Promise<void>
    readonly bytesWritten: number
    readonly entryCount: number
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EXTRA_ID = 0x0001
const FLAG_UTF8 = 0x0800
const VERSION_DEFLATE = 20
const VERSION_ZIP64 = 45
const MAX_32 = 0xffffffff
const MAX_16 = 0xffff

interface WrittenEntry {
    name: Uint8Array
    method: 0 | 8
    dosTime: number
    dosDate: number
    crc: number
    compressedSize: number
    size: number
    offset: number
    /** Whether this entry's central record carries the zip64 extra field. */
    zip64: boolean
}

/** The DOS date and time a zip entry carries: two-second resolution, local time, 1980 at the earliest. */
export function dosDateTime(epochMs: number): { dosTime: number; dosDate: number } {
    const date = new Date(epochMs)
    const year = date.getFullYear()
    if (!Number.isFinite(year) || year < 1980) return { dosTime: 0, dosDate: (1 << 5) | 1 }
    const dosDate = ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
    return { dosTime, dosDate }
}

class ByteBuilder {
    private readonly view: DataView
    readonly bytes: Uint8Array<ArrayBuffer>
    private at = 0

    constructor(length: number) {
        this.bytes = new Uint8Array(length)
        this.view = new DataView(this.bytes.buffer)
    }

    u16(value: number): this {
        this.view.setUint16(this.at, value, true)
        this.at += 2
        return this
    }

    u32(value: number): this {
        this.view.setUint32(this.at, value, true)
        this.at += 4
        return this
    }

    u64(value: number): this {
        this.view.setBigUint64(this.at, BigInt(value), true)
        this.at += 8
        return this
    }

    raw(bytes: Uint8Array): this {
        this.bytes.set(bytes, this.at)
        this.at += bytes.length
        return this
    }
}

export function createZipWriter(sink: ZipSink, options: ZipWriterOptions = {}): ZipWriter {
    const now = options.now ?? (() => Date.now())
    const forceZip64 = options.forceZip64 ?? false
    const level = options.level ?? 6
    const entries: WrittenEntry[] = []
    const paths = new Set<string>()
    let offset = 0
    let closed = false
    /** Adds and the close are serialised on this chain, so concurrent callers land in order. */
    let queue: Promise<void> = Promise.resolve()

    async function emit(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        await sink.write(bytes)
        offset += bytes.length
    }

    async function append(path: string, bytes: Uint8Array, addOptions: ZipAddOptions): Promise<void> {
        if (closed) throw new Error('the zip is closed')
        if (paths.has(path)) throw new Error(`"${path}" is already in the zip`)
        paths.add(path)
        const name = strToU8(path)
        const method: 0 | 8 = addOptions.compress ? 8 : 0
        const data = method === 8 ? deflateSync(bytes, { level }) : bytes
        const { dosTime, dosDate } = dosDateTime(addOptions.mtime ?? now())
        const entry: WrittenEntry = {
            name,
            method,
            dosTime,
            dosDate,
            crc: crc32(bytes),
            compressedSize: data.length,
            size: bytes.length,
            offset,
            zip64: forceZip64 || bytes.length >= MAX_32 || data.length >= MAX_32 || offset >= MAX_32,
        }
        // The local header's zip64 extra must carry both sizes whenever it is present, and a
        // local record cannot know its own offset, so the offset overflow is the central
        // directory's concern alone.
        const localZip64 = forceZip64 || bytes.length >= MAX_32 || data.length >= MAX_32
        const extraLength = localZip64 ? 20 : 0
        const header = new ByteBuilder(30 + name.length + extraLength)
            .u32(LOCAL_HEADER_SIGNATURE)
            .u16(localZip64 ? VERSION_ZIP64 : VERSION_DEFLATE)
            .u16(FLAG_UTF8)
            .u16(method)
            .u16(dosTime)
            .u16(dosDate)
            .u32(entry.crc)
            .u32(localZip64 ? MAX_32 : data.length)
            .u32(localZip64 ? MAX_32 : bytes.length)
            .u16(name.length)
            .u16(extraLength)
            .raw(name)
        if (localZip64) header.u16(ZIP64_EXTRA_ID).u16(16).u64(bytes.length).u64(data.length)
        await emit(header.bytes)
        // A view over a larger buffer (a slice of something bigger) is copied so the sink's
        // contract - ArrayBuffer-backed, exactly these bytes - holds for every chunk.
        await emit(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data as Uint8Array<ArrayBuffer>) : data.slice())
        entries.push(entry)
    }

    async function finish(): Promise<void> {
        if (closed) return
        closed = true
        const directoryOffset = offset
        for (const entry of entries) {
            const extraLength = entry.zip64 ? 4 + 24 : 0
            const record = new ByteBuilder(46 + entry.name.length + extraLength)
                .u32(CENTRAL_HEADER_SIGNATURE)
                .u16(entry.zip64 ? VERSION_ZIP64 : VERSION_DEFLATE)
                .u16(entry.zip64 ? VERSION_ZIP64 : VERSION_DEFLATE)
                .u16(FLAG_UTF8)
                .u16(entry.method)
                .u16(entry.dosTime)
                .u16(entry.dosDate)
                .u32(entry.crc)
                .u32(entry.zip64 ? MAX_32 : entry.compressedSize)
                .u32(entry.zip64 ? MAX_32 : entry.size)
                .u16(entry.name.length)
                .u16(extraLength)
                .u16(0) // comment length
                .u16(0) // disk number start
                .u16(0) // internal attributes
                .u32(0) // external attributes
                .u32(entry.zip64 ? MAX_32 : entry.offset)
                .raw(entry.name)
            // In the central directory the extra lists, in order, only the fields marked
            // overflowed above; all three are marked whenever the entry is zip64 at all.
            if (entry.zip64) record.u16(ZIP64_EXTRA_ID).u16(24).u64(entry.size).u64(entry.compressedSize).u64(entry.offset)
            await emit(record.bytes)
        }
        const directorySize = offset - directoryOffset
        const needsZip64 =
            forceZip64 ||
            entries.some((entry) => entry.zip64) ||
            entries.length >= MAX_16 ||
            directorySize >= MAX_32 ||
            directoryOffset >= MAX_32
        if (needsZip64) {
            const zip64EndOffset = offset
            await emit(
                new ByteBuilder(56)
                    .u32(ZIP64_END_SIGNATURE)
                    .u64(44) // size of the record after this field
                    .u16(VERSION_ZIP64)
                    .u16(VERSION_ZIP64)
                    .u32(0) // this disk
                    .u32(0) // disk with the central directory
                    .u64(entries.length)
                    .u64(entries.length)
                    .u64(directorySize)
                    .u64(directoryOffset).bytes,
            )
            await emit(new ByteBuilder(20).u32(ZIP64_LOCATOR_SIGNATURE).u32(0).u64(zip64EndOffset).u32(1).bytes)
        }
        await emit(
            new ByteBuilder(22)
                .u32(END_SIGNATURE)
                .u16(0)
                .u16(0)
                .u16(needsZip64 ? MAX_16 : entries.length)
                .u16(needsZip64 ? MAX_16 : entries.length)
                .u32(needsZip64 ? MAX_32 : directorySize)
                .u32(needsZip64 ? MAX_32 : directoryOffset)
                .u16(0).bytes,
        )
    }

    return {
        add(path, bytes, addOptions = {}) {
            const turn = queue.then(() => append(path, bytes, addOptions))
            // A failed add must not poison the chain for the entries behind it.
            queue = turn.catch(() => {})
            return turn
        },
        close() {
            const turn = queue.then(finish)
            queue = turn.catch(() => {})
            return turn
        },
        get bytesWritten() {
            return offset
        },
        get entryCount() {
            return entries.length
        },
    }
}
