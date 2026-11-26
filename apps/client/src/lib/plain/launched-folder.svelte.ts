/**
 * A folder the operating system handed to a Native App, from the moment the shell gives it until
 * the Graphs page takes it. That page opens it as it opens a folder the person chooses there, and asks
 * what to do with one it does not know.
 */
import type { FolderHandle } from '../native/folder-ref'

let launched = $state.raw<FolderHandle | null>(null)

export const launchedFolder = {
    /** The folder waiting to be opened. Reactive. */
    get current(): FolderHandle | null {
        return launched
    },
    set(folder: FolderHandle | null): void {
        launched = folder
    },
}
