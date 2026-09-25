/**
 * Turn a failed write to the graph folder into a sentence the user can act on (AGENTS.md rule 6:
 * what happened, why, what next). The File System Access API reports faults as DOMExceptions
 * whose `name` is the only stable signal. The sync path's `describeSyncFailure` reads those as
 * IndexedDB or network faults and falls back to "the sync server could not be reached", which
 * is wrong for a folder on disk - so the [[Filesystem Backend]] has its own map.
 *
 * Every sentence ends by saying the edits are kept: the buffer stays dirty until a retry
 * succeeds (`FilesystemDocumentStoreOptions.onSaveError`), and the user should know that closing
 * the tab is what loses them.
 *
 * Pure, so the mapping is unit tested rather than inferred from a screenshot.
 */

const KEPT = 'Your edits are kept in this tab until a save succeeds.'

export function describeFilesystemSaveFailure(error: unknown, concept: string): string {
    const opening = `Could not save “${concept}”.`
    const name = error instanceof Error ? error.name : ''
    switch (name) {
        case 'QuotaExceededError':
            return `${opening} The disk this folder is on is full. Free up some space, then retry. ${KEPT}`
        case 'NotAllowedError':
        case 'SecurityError':
            return `${opening} Permission to write to the folder has lapsed. Grant access again when the browser asks, then retry. ${KEPT}`
        case 'NoModificationAllowedError':
            return `${opening} The file is locked by another program - a sync tool, or an editor holding it open. Close that, then retry. ${KEPT}`
        case 'NotFoundError':
            return `${opening} The folder is no longer where it was - a drive unplugged, or the folder moved. Make it available again, then retry. ${KEPT}`
        case 'NotReadableError':
            return `${opening} The file could not be read when it was opened, so nothing is written over it. Once it can be read the app reloads it, or asks you to choose if you have typed since. ${KEPT}`
        // Chromium's catch-all for a failed file operation. For a folder on disk it means the
        // rename of the swap file over the target was refused, which on Windows is another
        // process holding the file open (write-retry.ts tried once more before this was raised).
        // The sentence stays plain: which program it was is for the user docs (Troubleshooting).
        case 'InvalidStateError':
            return `${opening} Another program was using the file at the same time. Retry in a moment. If it keeps happening, check what else is using this folder. ${KEPT}`
        default: {
            const detail = error instanceof Error && error.message ? ` The browser reported: ${error.message}.` : ''
            return `${opening}${detail} Retry in a moment. ${KEPT}`
        }
    }
}
