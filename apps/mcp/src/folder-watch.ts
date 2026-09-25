/**
 * The folder watcher for `serve --folder`: `fs.watch` over the whole graph directory, feeding
 * the folder backend's reconcile pass so the index follows an edit made in an editor or by the
 * agent writing markdown directly, without waiting for the next tool call. Best-effort by
 * design: a filesystem that cannot be watched (some network mounts) is reported once and the
 * per-call reconcile carries on alone, and the debounce and coalescing live in the backend, so
 * this is only the event source ([[2026-09-18 Headless Client Serves A Local Folder]]).
 */

import { statSync, watch, type FSWatcher } from 'node:fs'

/** A `HeadlessFolderDeps.watch` over `folder`; `onError` hears a watcher that could not start or died. */
export function watchFolder(folder: string, onError: (error: Error) => void): (trigger: () => void) => () => void {
    return (trigger) => {
        let watcher: FSWatcher | undefined
        try {
            // Node's recursive watcher on Linux neither throws nor errors for a directory that is
            // not there; it simply never fires. Say so up front instead of watching nothing.
            if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${folder} is not a directory that can be watched`)
            watcher = watch(folder, { recursive: true }, () => trigger())
            watcher.on('error', (error) => {
                onError(error instanceof Error ? error : new Error(String(error)))
                watcher?.close()
                watcher = undefined
            })
        } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)))
            return () => {}
        }
        return () => {
            watcher?.close()
            watcher = undefined
        }
    }
}
