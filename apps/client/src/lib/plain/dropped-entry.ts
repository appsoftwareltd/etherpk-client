/**
 * What was dropped onto the app from the device's file manager: a folder, to open as the Graphs
 * page's **Open folder** does, or a markdown file, to show on its own.
 *
 * A drop carries handles only in browsers with the File System Access API
 * (`getAsFileSystemHandle`). Elsewhere a drop carries copies of files, which could not be saved
 * back, so nothing is taken from it.
 */

type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }

/** True while something from the file manager is being dragged over the page. */
export function carriesFiles(transfer: DataTransfer | null): boolean {
    return [...(transfer?.types ?? [])].includes('Files')
}

/**
 * The first folder dropped, else the first file, else null. The handles are asked for before the
 * first `await`: a drop's items are emptied once its handler returns.
 */
export async function droppedHandle(transfer: DataTransfer | null): Promise<FileSystemHandle | null> {
    const asked = [...(transfer?.items ?? [])]
        .filter((item) => item.kind === 'file')
        .map((item) => (item as HandleItem).getAsFileSystemHandle?.() ?? Promise.resolve(null))
    const handles = (await Promise.all(asked.map((one) => one.catch(() => null)))).filter((handle): handle is FileSystemHandle => handle !== null)
    return handles.find((handle) => handle.kind === 'directory') ?? handles[0] ?? null
}

/** A file EtherPK shows on its own: markdown, by its name. */
export function isMarkdownFileName(name: string): boolean {
    return /\.(md|markdown)$/i.test(name)
}

/** Why a drop is not opened, in words for the person, or null for a folder or a markdown file. */
export function dropRefusal(dropped: FileSystemHandle | null): string | null {
    if (dropped === null) return 'This browser does not hand over what was dropped. Use Open folder instead.'
    if (dropped.kind === 'directory' || isMarkdownFileName(dropped.name)) return null
    return `EtherPK opens a folder or a markdown file dropped here. ${dropped.name} is neither.`
}
