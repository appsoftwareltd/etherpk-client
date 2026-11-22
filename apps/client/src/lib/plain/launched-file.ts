/**
 * Reading a launch from the device's file manager (the manifest's `file_handlers`): which file it
 * carries, and where that file is inside a folder the person then chooses.
 */

/** What the launch queue carries besides an address: the files, for a launch from a file. */
export interface FileLaunch {
    files?: readonly FileSystemHandle[]
}

/** The first file of a launch, or null for a launch that carries none. */
export function fileOfLaunch(launch: FileLaunch): FileSystemFileHandle | null {
    const file = launch.files?.find((handle) => handle.kind === 'file')
    return (file as FileSystemFileHandle | undefined) ?? null
}

/** Where `file` is inside `folder`, as a path, or null when the folder does not hold it. */
export async function pathInFolder(folder: FileSystemDirectoryHandle, file: FileSystemFileHandle): Promise<string | null> {
    const segments = await folder.resolve(file)
    return segments === null || segments.length === 0 ? null : segments.map((segment) => segment.normalize('NFC')).join('/')
}
