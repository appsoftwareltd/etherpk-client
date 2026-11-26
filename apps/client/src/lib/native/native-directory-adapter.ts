/**
 * The {@link DirectoryAdapter} of an installed app: a Graph Folder reached through the shell.
 *
 * Where the browser's adapter (web-fs-adapter.ts) opens each file for its stamps, the shell answers a
 * listing with them in one call, and reads many files in one. A write is atomic and can be
 * conditional, which the browser's cannot be.
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import { type DirectoryAdapter, type ExpectedStamp, type FileContent, type Subdir, SUBDIRS } from '../storage/fs/directory-adapter.js'
import { writeWithOneRetry } from '../storage/fs/write-retry.js'
import { type NativeFolderRef, shell } from './folder-ref.js'

const isNotFound = (error: unknown) => (error as { name?: unknown } | null)?.name === 'NotFoundError'
const encoder = new TextEncoder()
// As the browser's `File.text()` reads a file: a byte order mark is not part of the text.
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** How many files one call reads. Large enough to save the round trips, small enough to hold in memory. */
export const READ_MANY_BATCH = 100

/** The path of a file in a content directory, or of one beside them. A name is one name, never a path. */
function pathOf(subdir: Subdir | null, name: string): string {
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) throw new TypeError(`“${name}” is not a file name.`)
    const composed = name.normalize('NFC')
    return subdir === null ? composed : `${subdir}/${composed}`
}

export function createNativeDirectoryAdapter(root: NativeFolderRef, bridge: () => NativeBridge = shell): DirectoryAdapter {
    const folder = root.nativeId

    async function readBytes(path: string) {
        return bridge().call('fs.read', { folder, path })
    }

    /** Files deleted while a listing is being read are not in it, so one that is gone answers null. */
    async function readMany(paths: string[]): Promise<(FileContent | null)[]> {
        const out: (FileContent | null)[] = []
        for (let at = 0; at < paths.length; at += READ_MANY_BATCH) {
            const batch = await bridge().call('fs.readMany', { folder, paths: paths.slice(at, at + READ_MANY_BATCH) })
            for (const read of batch) out.push(read && { text: decode(read.bytes), lastModified: read.lastModified, size: read.size })
        }
        return out
    }

    async function writeBytes(path: string, bytes: Uint8Array<ArrayBuffer>, ifStamp?: ExpectedStamp) {
        // The shell answers `InvalidStateError` for a file another program holds, as the browser does.
        return writeWithOneRetry(() => bridge().call('fs.write', { folder, path, bytes, createDirectories: true, ...(ifStamp ? { ifStamp } : {}) }))
    }

    return {
        async list(subdir) {
            let entries
            try {
                entries = await bridge().call('fs.list', { folder, path: subdir, stamps: true })
            } catch (error) {
                if (!isNotFound(error)) throw error
                // A graph folder with one of its directories missing gets it back, as the browser's
                // adapter does. The same error means the whole folder is gone, and then this rejects too.
                await bridge().call('fs.createDirectory', { folder, path: subdir })
                return []
            }
            return entries
                .filter((entry) => entry.kind === 'file')
                .map((entry) => ({ name: entry.name, lastModified: entry.lastModified ?? 0, size: entry.size ?? 0 }))
        },

        async read(subdir, name) {
            const { bytes, lastModified, size } = await readBytes(pathOf(subdir, name))
            return { text: decode(bytes), lastModified, size }
        },

        readMany: (subdir, names) => readMany(names.map((name) => pathOf(subdir, name))),

        async write(subdir, name, text, ifStamp) {
            return { text, ...(await writeBytes(pathOf(subdir, name), encoder.encode(text), ifStamp)) }
        },

        async readBinary(subdir, name) {
            const { bytes, lastModified } = await readBytes(pathOf(subdir, name))
            return { bytes, lastModified }
        },

        async writeBinary(subdir, name, bytes) {
            const { lastModified } = await writeBytes(pathOf(subdir, name), bytes)
            return { bytes, lastModified }
        },

        async exists(subdir, name) {
            return (await bridge().call('fs.stat', { folder, path: pathOf(subdir, name) }))?.kind === 'file'
        },

        async remove(subdir, name) {
            await bridge().call('fs.remove', { folder, path: pathOf(subdir, name) })
        },

        async ensureSkeleton() {
            for (const subdir of SUBDIRS) await bridge().call('fs.createDirectory', { folder, path: subdir })
        },

        async readRootFile(name) {
            try {
                const { bytes, lastModified, size } = await readBytes(pathOf(null, name))
                return { text: decode(bytes), lastModified, size }
            } catch (error) {
                // Only "not there" is null. A folder that is gone says the same, and then the write that
                // would follow is refused too, because the shell never makes the folder again.
                if (isNotFound(error)) return null
                throw error
            }
        },

        async writeRootFile(name, text) {
            return { text, ...(await writeBytes(pathOf(null, name), encoder.encode(text))) }
        },
    }
}
