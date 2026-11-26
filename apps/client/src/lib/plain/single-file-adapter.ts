/**
 * A {@link FolderTreeAdapter} over one file and nothing else: what EtherPK has when a file is
 * opened from the device's file manager. The system hands over that file alone, with no access to
 * the folder it is in, so the file can be read and saved and nothing beside it can be reached.
 *
 * Everything that needs the folder (another file, a new one, the hidden `.etherpk` folder, a
 * picture beside the document) is refused with a reason that says to open the folder.
 */
import { writeFileContents } from '../storage/fs/file-write'

import { type FileBytes, type FileStamp, type FolderTreeAdapter, notFound } from './folder-tree-adapter'

/** Why something beside the one file cannot be done. */
export class NeedsFolderError extends Error {
    constructor(what: string) {
        super(`Open the folder to ${what}. EtherPK was given this one file, not the folder it is in.`)
        this.name = 'NeedsFolderError'
    }
}

/** The one file, however it was given: by the browser or by an installed app's shell. */
export interface SingleFile {
    readonly name: string
    stat(): Promise<FileStamp>
    read(): Promise<FileBytes>
    write(bytes: Uint8Array<ArrayBuffer>, expected?: FileStamp): Promise<FileStamp>
}

/** A file the browser gave. */
export function browserSingleFile(handle: FileSystemFileHandle): SingleFile {
    const stat = async (): Promise<FileStamp> => {
        const file = await handle.getFile()
        return { lastModified: file.lastModified, size: file.size }
    }
    return {
        name: handle.name,
        stat,
        async read() {
            const file = await handle.getFile()
            return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified, size: file.size }
        },
        async write(bytes) {
            await writeFileContents(handle, bytes)
            return stat()
        },
    }
}

export function createSingleFileAdapter(file: SingleFile): FolderTreeAdapter {
    const name = file.name.normalize('NFC')
    const isTheFile = (path: string) => path === name

    return {
        async list(dir) {
            if (dir !== '') throw notFound(dir)
            return [{ name, kind: 'file' }]
        },
        async stat(path) {
            if (path === '') return { kind: 'directory' }
            return isTheFile(path) ? { kind: 'file', ...(await file.stat()) } : null
        },
        async canonicalPath(path) {
            return isTheFile(path) ? name : null
        },
        async read(path) {
            if (!isTheFile(path)) throw notFound(path)
            return file.read()
        },
        async write(path, bytes, expected) {
            if (!isTheFile(path)) throw new NeedsFolderError('add a file beside this one')
            // A file expected to be gone is one a Restore writes back. Neither a browser nor a shell can
            // write a file by its id only if nothing is there, so it is looked for first: one that came
            // back is refused as a moved file is, and the store reads and judges it again.
            if (expected === 'absent') {
                if (await present(file)) throw new DOMException('The file is there again.', 'NoModificationAllowedError')
                return file.write(bytes)
            }
            return file.write(bytes, expected)
        },
        async createDirectory(path) {
            if (path !== '') throw new NeedsFolderError('keep anything beside this file')
        },
        async remove() {
            throw new NeedsFolderError('delete a file')
        },
        async move() {
            throw new NeedsFolderError('rename or move a file')
        },
    }
}

async function present(file: SingleFile): Promise<boolean> {
    try {
        await file.stat()
        return true
    } catch (error) {
        if ((error as DOMException | null)?.name === 'NotFoundError') return false
        throw error
    }
}
