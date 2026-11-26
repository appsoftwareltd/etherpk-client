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
import { isNativeApp } from '../../native/bridge.js'

/** What each fault means and what to do next. The last is said in an installed app, which has no browser to ask. */
const REASONS: Record<string, { browser: string; installed?: string }> = {
    QuotaExceededError: { browser: 'The disk this folder is on is full. Free up some space, then retry.' },
    NotAllowedError: {
        browser: 'Permission to write to the folder has lapsed. Grant access again when the browser asks, then retry.',
        installed: 'EtherPK no longer has permission to write to the folder. Copy your edits, then open it again from the Graphs page and choose the folder.',
    },
    NoModificationAllowedError: { browser: 'The file is locked by another program - a sync tool, or an editor holding it open. Close that, then retry.' },
    NotFoundError: { browser: 'The folder is no longer where it was - a drive unplugged, or the folder moved. Make it available again, then retry.' },
    NotReadableError: {
        browser: 'The file could not be read when it was opened, so nothing is written over it. Once it can be read the app reloads it, or asks you to choose if you have typed since.',
    },
    // Chromium's catch-all for a failed file operation. For a folder on disk it means the
    // rename of the swap file over the target was refused, which on Windows is another
    // process holding the file open (write-retry.ts tried once more before this was raised).
    // The sentence stays plain: which program it was is for the user docs (Troubleshooting).
    InvalidStateError: { browser: 'Another program was using the file at the same time. Retry in a moment. If it keeps happening, check what else is using this folder.' },
}
REASONS.SecurityError = REASONS.NotAllowedError

/** A fault with no reason of its own: what was reported, for whoever can read it. */
function unknownReason(error: unknown, installed: boolean): string {
    const detail = error instanceof Error && error.message ? `The ${installed ? 'system' : 'browser'} reported: ${error.message}. ` : ''
    return `${detail}Retry in a moment.`
}

function reasonFor(error: unknown, installed: boolean): string {
    const reason = error instanceof Error ? REASONS[error.name] : undefined
    if (!reason) return unknownReason(error, installed)
    return (installed && reason.installed) || reason.browser
}

export function describeFilesystemSaveFailure(error: unknown, concept: string, installed = isNativeApp()): string {
    return `Could not save “${concept}”. ${reasonFor(error, installed)} Your edits are kept in this ${installed ? 'window' : 'tab'} until a save succeeds.`
}
