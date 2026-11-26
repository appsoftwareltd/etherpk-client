/**
 * Turn a Folder graph's failed open into a sentence the person can act on: what happened, why,
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

import { isNativeApp } from '#lib/native/bridge.js'
import { describeStorageFault } from '#lib/sync/sync-error-copy.js'

const OPENING = 'Could not open the graph.'
const NO_PERMISSION = 'The browser no longer lets EtherPK use this graph’s folder. Select Try again, and allow access if the browser asks.'
const NO_PERMISSION_INSTALLED = 'EtherPK no longer has permission to use this graph’s folder. Select Try again to choose the folder.'
const NEXT_STEP = 'Try again, and reload the page if it keeps happening.'

export function describeFolderOpenFailure(error: unknown, installed = isNativeApp()): string {
    return describeOpenFailure(error, installed, {
        opening: OPENING,
        notFound: 'Its folder could not be found on disk: it may have been moved, renamed, or deleted. Forget the graph on the Graphs page (your files are untouched) and use Open folder to pick it again.',
        refused: installed ? NO_PERMISSION_INSTALLED : NO_PERMISSION,
        next: NEXT_STEP,
    })
}

/**
 * The same for a folder the person has just chosen, for a Plain Folder that lost its own. The next step
 * is to choose a folder again, which is the button beside the message.
 */
export function describeChosenFolderFailure(error: unknown, installed = isNativeApp()): string {
    return describeOpenFailure(error, installed, {
        opening: 'Could not open that folder.',
        notFound: 'It could not be found on disk: it may have been moved, renamed, or deleted. Choose the folder again.',
        refused: installed
            ? 'EtherPK was not given permission to use the folder. Choose the folder again.'
            : 'The browser did not let EtherPK use the folder. Choose the folder again, and allow access if the browser asks.',
        next: installed
            ? 'Choose the folder again, and close and reopen EtherPK if this keeps happening.'
            : 'Choose the folder again, and reload the page if this keeps happening.',
    })
}

interface OpenWords {
    opening: string
    notFound: string
    refused: string
    next: string
}

function describeOpenFailure(error: unknown, installed: boolean, words: OpenWords): string {
    switch (error instanceof Error ? error.name : '') {
        // The stored handle no longer resolves.
        case 'NotFoundError':
            return `${words.opening} ${words.notFound}`
        // The permission check passed and a read was refused after it. Try again is a click, so the
        // browser can ask again from there.
        case 'NotAllowedError':
        case 'SecurityError':
            return `${words.opening} ${words.refused}`
        case 'NoModificationAllowedError':
            return `${words.opening} A file in its folder is locked by another program, such as a sync tool or an editor holding it open. Close that, then try again.`
        case 'NotReadableError':
            return `${words.opening} A file in its folder could not be read, which usually means another program is using it. Close that, then try again.`
    }
    // An open also uses the browser's own storage, for the graph list and the search index.
    const storage = describeStorageFault(error)
    if (storage) return `${words.opening} ${storage}`

    return `${words.opening}${reported(error, installed)} ${words.next}`
}

/** What the fault itself said, for a fault with no sentence of its own. */
function reported(error: unknown, installed: boolean): string {
    if (!(error instanceof Error) || !error.message) return ''
    return ` The ${installed ? 'system' : 'browser'} reported: ${error.message.replace(/\.$/, '')}.`
}
