/**
 * Hearing of changes other programs make to a folder, where the shell can watch one.
 *
 * In a browser there is no such thing, so `watchFolder` answers null there and the folder is looked
 * over on focus and on a poll alone.
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import { nativeBridge } from './bridge.js'
import { isNativeFolder } from './folder-ref.js'

/**
 * Start watching. `changed` hears of each change, with the paths that changed or null when the shell
 * cannot say, and `lost` hears once that the watch has ended. Returns what stops it.
 */
export type FolderWatch = (changed: (paths: readonly string[] | null) => void, lost: () => void) => () => void

/** How to watch `handle`, or null when nothing can. */
export function folderWatch(handle: unknown, bridge: NativeBridge | null = nativeBridge()): FolderWatch | null {
    if (!bridge || !isNativeFolder(handle) || !bridge.info.features.watch) return null
    const folder = handle.nativeId
    return (changed, lost) => {
        let stopped = false
        let watch: string | null = null

        function end(): void {
            stopped = true
            offChanged()
            offLost()
        }
        const offChanged = bridge.on('fsChanged', (event) => {
            if (event.folder === folder) changed(event.paths)
        })
        const offLost = bridge.on('watchLost', (event) => {
            if (event.folder !== folder) return
            end()
            lost()
        })
        const release = (id: string) => {
            bridge.call('fs.unwatch', { watch: id }).catch((error: unknown) => console.warn('[folder-watch] a watch could not be ended', error))
        }

        bridge.call('fs.watch', { folder }).then(
            (id) => {
                watch = id
                if (stopped) return release(id)
                // Anything written between the folder being read and the watch starting was not heard of.
                changed(null)
            },
            (error: unknown) => {
                if (stopped) return
                console.warn('[folder-watch] the folder cannot be watched, so it is looked over on a timer', error)
                end()
                lost()
            },
        )

        return () => {
            if (stopped) return
            end()
            if (watch !== null) release(watch)
        }
    }
}
