/**
 * The file the device's file manager handed to EtherPK (the manifest's `file_handlers`), from the
 * moment the browser delivers it until the page that shows it takes it.
 *
 * The browser delivers it through `launchQueue`, which the root layout reads on every page, while
 * the file is shown by `/open-file`. This is the hand-over between the two. A reload has nothing to
 * hand over: the browser gives the file once.
 */

import type { FileHandle } from '../native/folder-ref'

let launched = $state.raw<FileHandle | null>(null)

export const launchedFile = {
    /** The file waiting to be shown. Reactive. */
    get current(): FileHandle | null {
        return launched
    },
    set(file: FileHandle | null): void {
        launched = file
    },
}
