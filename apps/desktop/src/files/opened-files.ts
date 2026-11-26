/** Single files the person opened with EtherPK. */
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { FileId, FileInfo, FileStamp } from '@appsoftwareltd/etherpk-native-bridge'
import { NativeFailure } from '../failure.ts'
import { readWhole, writeLocked, type ReadResult } from '../fs/folder-files.ts'
import type { Grants } from '../fs/grants.ts'
import type { Locks } from '../fs/locks.ts'
import { stampOf } from '../fs/stamp.ts'

/** What the Client opens by media type. An unknown one is the empty string, as the interface says. */
const TYPES: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.html': 'text/html', '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
}

export class OpenedFiles {
    constructor(private readonly grants: Grants, private readonly locks: Locks) {}

    /**
     * Give the app one file. The person's act (the file manager, the command line) is what allows it.
     * Only an ordinary file is given: a named pipe or a device would block a read, and its grant would
     * outlast the refusal.
     */
    async add(path: string): Promise<FileInfo> {
        if (!(await stat(path)).isFile()) throw new NativeFailure('TypeMismatchError', 'It is not an ordinary file.')
        return this.info(await this.grants.add('file', path))
    }

    async info(file: FileId): Promise<FileInfo> {
        const path = this.grants.path('file', file)
        const stats = await stat(path, { bigint: true })
        if (!stats.isFile()) throw new NativeFailure('TypeMismatchError', 'It is not a file.')
        return { id: file, name: basename(path).normalize('NFC'), type: TYPES[extname(path).toLowerCase()] ?? '', displayPath: path, ...stampOf(stats) }
    }

    async read(file: FileId): Promise<ReadResult & FileInfo> {
        const read = await readWhole(this.grants.path('file', file))
        return { ...(await this.info(file)), ...read }
    }

    async readPart(file: FileId, offset: number, length: number): Promise<{ bytes: Uint8Array<ArrayBuffer> }> {
        // Opening a named pipe for reading would wait for a writer, for ever.
        const handle = await open(this.grants.path('file', file), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
        try {
            const { size } = await handle.stat()
            // The page's length says how much it wants, and the file how much there is to hold.
            const bytes = new Uint8Array(new ArrayBuffer(Math.max(0, Math.min(length, size - offset))))
            let filled = 0
            while (filled < bytes.length) {
                const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, offset + filled)
                if (bytesRead === 0) break
                filled += bytesRead
            }
            return { bytes: bytes.slice(0, filled) }
        } finally {
            await handle.close()
        }
    }

    async write(file: FileId, bytes: Uint8Array, ifStamp?: FileStamp): Promise<FileStamp> {
        // The file may be a link: what it leads to is replaced and the link stays.
        const path = await realpath(this.grants.path('file', file))
        return writeLocked(this.locks, path, bytes, ifStamp)
    }

    async release(file: FileId): Promise<void> {
        await this.grants.forget('file', file)
    }
}
