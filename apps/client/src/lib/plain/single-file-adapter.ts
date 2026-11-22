/**
 * A {@link FolderTreeAdapter} over one file and nothing else: what EtherPK has when a file is
 * opened from the device's file manager. The browser hands over that file alone, with no access to
 * the folder it is in, so the file can be read and saved and nothing beside it can be reached.
 *
 * Everything that needs the folder (another file, a new one, the hidden `.etherpk` folder, a
 * picture beside the document) is refused with a reason that says to open the folder.
 */
import { writeFileContents } from '../storage/fs/file-write'

import { type FileStamp, type FolderTreeAdapter, notFound } from './folder-tree-adapter'

/** Why something beside the one file cannot be done. */
export class NeedsFolderError extends Error {
    constructor(what: string) {
        super(`Open the folder to ${what}. EtherPK was given this one file, not the folder it is in.`)
        this.name = 'NeedsFolderError'
    }
}

export function createSingleFileAdapter(handle: FileSystemFileHandle): FolderTreeAdapter {
    const name = handle.name.normalize('NFC')
    const stamp = async (): Promise<FileStamp> => {
        const file = await handle.getFile()
        return { lastModified: file.lastModified, size: file.size }
    }
    const isTheFile = (path: string) => path === name

    return {
        async list(dir) {
            if (dir !== '') throw notFound(dir)
            return [{ name, kind: 'file' }]
        },
        async stat(path) {
            if (path === '') return { kind: 'directory' }
            return isTheFile(path) ? { kind: 'file', ...(await stamp()) } : null
        },
        async canonicalPath(path) {
            return isTheFile(path) ? name : null
        },
        async read(path) {
            if (!isTheFile(path)) throw notFound(path)
            const file = await handle.getFile()
            return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified, size: file.size }
        },
        async write(path, bytes) {
            if (!isTheFile(path)) throw new NeedsFolderError('add a file beside this one')
            await writeFileContents(handle, bytes)
            return stamp()
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
