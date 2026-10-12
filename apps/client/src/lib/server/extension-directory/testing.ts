/**
 * Test support: npm package tarballs written by hand, as npm writes them (ustar headers, every file
 * under `package/`, gzipped), and the integrity hash npm gives one. Imported by tests only.
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const encoder = new TextEncoder()

function header(name: string, size: number, type: string): Uint8Array {
    const block = new Uint8Array(512)
    const put = (offset: number, text: string) => block.set(encoder.encode(text), offset)
    put(0, name)
    put(100, '0000644\0')
    put(108, '0000000\0')
    put(116, '0000000\0')
    put(124, `${size.toString(8).padStart(11, '0')}\0`)
    put(136, '00000000000\0')
    put(148, '        ')
    put(156, type)
    put(257, 'ustar\0')
    put(263, '00')
    let sum = 0
    for (const byte of block) sum += byte
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
    return block
}

/** One tar entry: its header and its data padded to whole blocks. `type` is the tar type flag. */
export function tarEntry(name: string, body: string | Uint8Array, type = '0'): Uint8Array[] {
    const data = typeof body === 'string' ? encoder.encode(body) : body
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data)
    return [header(name, data.length, type), padded]
}

/** A POSIX extended header naming the next entry's path. */
export function paxEntry(path: string): Uint8Array[] {
    const record = (length: number) => `${length} path=${path}\n`
    let length = record(0).length
    while (record(length).length !== length) length = record(length).length
    return tarEntry('PaxHeader', record(length), 'x')
}

/** The entries as a gzipped tar file. */
export function tarball(...entries: Uint8Array[][]): Uint8Array {
    const blocks = [...entries.flat(), new Uint8Array(1024)]
    const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0))
    let at = 0
    for (const block of blocks) {
        out.set(block, at)
        at += block.length
    }
    return gzipSync(out)
}

/** A package's tarball from its files, by path inside the package. */
export function packageTarball(files: Record<string, string | Uint8Array>): Uint8Array {
    return tarball(...Object.entries(files).map(([path, body]) => tarEntry(`package/${path}`, body)))
}

/** The integrity npm gives a tarball. */
export function integrityOf(bytes: Uint8Array): string {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}
