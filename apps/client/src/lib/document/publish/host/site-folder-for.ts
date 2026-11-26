/** A chosen [[Publish Folder]] as the publisher writes to one, whether a browser's handle or an installed app's folder. */
import { type FolderHandle, isNativeFolder } from '#lib/native/folder-ref.js'
import { nativeSiteFolder } from '#lib/native/native-site-folder.js'

import { directoryHandleFolder, type SiteFolder } from './site-writer'

export function siteFolderFor(folder: FolderHandle): SiteFolder {
    return isNativeFolder(folder) ? nativeSiteFolder(folder) : directoryHandleFolder(folder)
}
