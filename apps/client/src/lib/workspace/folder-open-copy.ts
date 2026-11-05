/**
 * Turn a Filesystem graph's failed open into a sentence the person can act on: what happened, why,
 * what next. A folder graph has no sync server, so `describeSyncFailure`'s fallback ("the sync server
 * could not be reached") sends people to check a connection that has nothing to do with it.
 *
 * `describeFilesystemSaveFailure` reads the same DOMException names for a save, but its sentences
 * are about one document, about writing, and about edits kept in the tab. An open has none of those,
 * and its next step is this notice's Try again rather than Retry saving, so the sentences are not
 * shared.
 *
 * Pure, so the mapping is unit tested rather than inferred from a screenshot.
 */

import { describeStorageFault } from '#lib/sync/sync-error-copy.js'

const OPENING = 'Could not open the graph.'
const NEXT_STEP = 'Try again, and reload the page if it keeps happening.'

export function describeFolderOpenFailure(error: unknown): string {
    switch (error instanceof Error ? error.name : '') {
        // The stored handle no longer resolves.
        case 'NotFoundError':
            return `${OPENING} Its folder could not be found on disk: it may have been moved, renamed, or deleted. Forget the graph on the Graphs page (your files are untouched) and use Open folder to pick it again.`
        // The permission check passed and a read was refused after it. Try again is a click, so the
        // browser can ask again from there.
        case 'NotAllowedError':
        case 'SecurityError':
            return `${OPENING} The browser no longer lets EtherPK use this graph’s folder. Select Try again, and allow access if the browser asks.`
        case 'NoModificationAllowedError':
            return `${OPENING} A file in its folder is locked by another program, such as a sync tool or an editor holding it open. Close that, then try again.`
        case 'NotReadableError':
            return `${OPENING} A file in its folder could not be read, which usually means another program is using it. Close that, then try again.`
    }
    // An open also uses the browser's own storage, for the graph list and the search index.
    const storage = describeStorageFault(error)
    if (storage) return `${OPENING} ${storage}`

    const detail = error instanceof Error && error.message ? ` The browser reported: ${error.message.replace(/\.$/, '')}.` : ''
    return `${OPENING}${detail} ${NEXT_STEP}`
}
