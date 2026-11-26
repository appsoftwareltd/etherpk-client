/**
 * Everything a Native App sets going as its page starts. Loaded by the root layout only where there
 * is a shell, so a browser downloads none of it.
 */
import type { NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'

import { goto } from '$app/navigation'
import { showNotice } from '#lib/activity/notices.js'
import { launchedFile } from '#lib/plain/launched-file.svelte.js'
import { launchedFolder } from '#lib/plain/launched-folder.svelte.js'
import { isMarkdownFileName } from '#lib/plain/dropped-entry.js'

import { closePrompt } from './close-guard.svelte.js'
import { nativeFileRef } from './file-ref.js'
import { nativeFolderRef } from './folder-ref.js'
import { GRAPHS_PATH } from './installed-pages.js'
import { listenForLaunches } from './launches.js'
import { watchExternalLinks } from './links.js'
import { watchDownloads } from './save-file.js'
import { watchTheme } from './theme.js'
import { appUpdates } from './updates.svelte.js'

const say = (text: string) => showNotice({ id: 'launch', tone: 'error', text })

/** Start it all. `first` says whether the app was opened with something that took it somewhere. */
export function startInstalledApp(bridge: NativeBridge): { first: Promise<boolean>; stop: () => void } {
    const launches = listenForLaunches(bridge, {
        goto: async (address) => void (await goto(address)),
        say,
        async openFile(file) {
            if (!isMarkdownFileName(file.name)) {
                say(`EtherPK opens markdown files, and ${file.name} is not a markdown file.`)
                await bridge.call('files.release', { file: file.id })
                return
            }
            launchedFile.set(nativeFileRef(file))
            await goto('/open-file')
        },
        async openFolder(folder) {
            launchedFolder.set(nativeFolderRef(folder))
            await goto(GRAPHS_PATH)
        },
    })
    const stops = [launches.stop, watchExternalLinks(), watchDownloads(), watchTheme(), closePrompt.listen(bridge), appUpdates.follow(bridge)]
    return { first: launches.first, stop: () => stops.forEach((stop) => stop()) }
}
