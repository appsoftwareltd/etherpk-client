/**
 * Reading an npm package's tarball (a gzipped tar file) into its files, for a release the
 * Extension Directory lists (ADR 0123). Written here rather than taken from a library because the
 * Client's server needs only a small, strict reader: regular files and folders, the POSIX and GNU
 * ways of writing long names, and a refusal for everything else. A link, a device, an absolute path
 * or one that climbs out of the package (`..`) makes the whole package unreadable, since its hash
 * was reviewed as a whole and nothing in it may point outside it.
 *
 * Every file sits under one root folder in an npm tarball (`package/`), which is removed.
 */
import { gunzipSync } from 'node:zlib'

export interface TarFile {
    /** The file's path inside the package, `/`-separated, with no root folder. */
    path: string
    data: Uint8Array
}

export interface TarLimits {
    /** The most bytes all the files may hold together, unpacked. */
    unpackedBytes: number
    /** The most files the package may hold. */
    files: number
}

const BLOCK = 512
const decoder = new TextDecoder()

/** A NUL-terminated header field as text. */
function field(header: Uint8Array, offset: number, length: number): string {
    const bytes = header.subarray(offset, offset + length)
    const end = bytes.indexOf(0)
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

/** A numeric header field: octal text, or base-256 when its first byte has the high bit set. */
function numeric(header: Uint8Array, offset: number, length: number): number {
    if (header[offset] & 0x80) {
        let value = 0
        for (let i = offset + 1; i < offset + length; i++) value = value * 256 + header[i]
        return value
    }
    const text = field(header, offset, length).trim()
    if (text === '') return 0
    // Octal digits only: a sign or any other character is a header no packer writes.
    if (!/^[0-7]+$/.test(text)) throw new Error('a header gives a size that is not a number of bytes')
    return parseInt(text, 8)
}

/** The `path` record of a POSIX extended header (`<length> path=<value>\n` records). */
function paxPath(data: Uint8Array): string | null {
    const text = decoder.decode(data)
    let at = 0
    while (at < text.length) {
        const space = text.indexOf(' ', at)
        if (space === -1) break
        const length = parseInt(text.slice(at, space), 10)
        if (!Number.isFinite(length) || length <= 0) break
        const record = text.slice(space + 1, at + length - 1)
        if (record.startsWith('path=')) return record.slice('path='.length)
        at += length
    }
    return null
}

/** A path inside the package, or why it may not be in one. */
function safePath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
    if (raw.includes('\0') || raw.includes('\\')) return { ok: false, error: `the path "${raw}" holds a character no package path may` }
    if (raw.startsWith('/')) return { ok: false, error: `the path "${raw}" is absolute` }
    const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
    if (parts.includes('..')) return { ok: false, error: `the path "${raw}" climbs out of the package` }
    return { ok: true, path: parts.join('/') }
}

/** The files of a gzipped tar file, its root folder removed. Throws, saying why, for one it refuses. */
export function readPackageTarball(gzipped: Uint8Array, limits: TarLimits): TarFile[] {
    let tar: Uint8Array
    try {
        tar = gunzipSync(gzipped, { maxOutputLength: limits.unpackedBytes + 64 * BLOCK + limits.files * 3 * BLOCK })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(/buffer|length|size/i.test(message) ? 'the package is larger unpacked than the Client accepts' : `the package is not a gzipped file (${message})`)
    }
    const files: TarFile[] = []
    let total = 0
    let root: string | null = null
    let longName: string | null = null
    for (let at = 0; at + BLOCK <= tar.length; ) {
        const header = tar.subarray(at, at + BLOCK)
        // Two empty blocks end the archive; one is enough to stop reading.
        if (header.every((byte) => byte === 0)) break
        const size = numeric(header, 124, 12)
        const type = String.fromCharCode(header[156] || 48)
        const dataStart = at + BLOCK
        const data = tar.subarray(dataStart, dataStart + size)
        if (data.length < size) throw new Error('the package ends part way through a file')
        at = dataStart + Math.ceil(size / BLOCK) * BLOCK

        if (type === 'x') {
            longName = paxPath(data)
            continue
        }
        if (type === 'L') {
            longName = field(data, 0, data.length)
            continue
        }
        if (type === 'g') continue
        const prefix = field(header, 345, 155)
        const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
        longName = null
        if (type === '5') continue
        if (type !== '0' && type !== '7') throw new Error(`"${name}" is a link or a special file, which a package may not hold`)

        const safe = safePath(name)
        if (!safe.ok) throw new Error(safe.error)
        const slash = safe.path.indexOf('/')
        if (slash === -1) throw new Error(`"${name}" is not inside the package's folder`)
        const top = safe.path.slice(0, slash)
        root ??= top
        if (top !== root) throw new Error(`"${name}" is outside the package's folder, ${root}/`)

        total += size
        if (total > limits.unpackedBytes) throw new Error('the package is larger unpacked than the Client accepts')
        if (files.length + 1 > limits.files) throw new Error(`the package holds more than ${limits.files} files`)
        files.push({ path: safe.path.slice(slash + 1), data: data.slice() })
    }
    return files
}
