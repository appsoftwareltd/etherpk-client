/**
 * What this tab has restored from a safety copy (`safety-copy.ts`), so the UI can say so.
 *
 * A heal is silent by nature - the read that discovers the loss simply answers correctly - and
 * silence is the wrong outcome for the person holding the phone: their documents are about to
 * download again, an unlock may ask for a passphrase it did not use to ask for, and they should
 * know the browser, not EtherPK, dropped the data. Tab-scoped module state, as `activity/store`
 * is: it is a notice for this session, not a record.
 */

export type RecoveredStateKind = 'graphs' | 'passkeys'

export interface StorageRecovery {
    kind: RecoveredStateKind
    /** Graph names for `graphs`; graph ids for `passkeys`. What was put back. */
    restored: string[]
}

let recoveries: StorageRecovery[] = []
const listeners = new Set<(all: readonly StorageRecovery[]) => void>()

function emit(): void {
    const snapshot = storageRecoveries()
    for (const listener of listeners) listener(snapshot)
}

/** Record a heal. Repeated reports of one kind merge, so two reads of one healed row are one line. */
export function reportStorageRecovery(recovery: StorageRecovery): void {
    const existing = recoveries.find((entry) => entry.kind === recovery.kind)
    if (existing) {
        existing.restored = [...new Set([...existing.restored, ...recovery.restored])]
    } else {
        recoveries.push({ kind: recovery.kind, restored: [...new Set(recovery.restored)] })
    }
    console.warn(
        `[storage] restored ${recovery.restored.length} ${recovery.kind} from this device's safety copy; the browser had lost them from IndexedDB`,
    )
    emit()
}

export function storageRecoveries(): readonly StorageRecovery[] {
    return recoveries.map((entry) => ({ kind: entry.kind, restored: [...entry.restored] }))
}

/** Subscribe; fires at once with what has already been restored. Returns an unsubscribe. */
export function subscribeStorageRecoveries(listener: (all: readonly StorageRecovery[]) => void): () => void {
    listeners.add(listener)
    listener(storageRecoveries())
    return () => {
        listeners.delete(listener)
    }
}

/** The person has read the notice; start afresh. */
export function acknowledgeStorageRecoveries(): void {
    recoveries = []
    emit()
}

/**
 * The notice, in three parts the UI lays out as a line, a bulleted list and a line. The cause
 * comes first because the person will otherwise blame EtherPK or the sync server; "local
 * storage" rather than "safety copy" because the mechanism's name means nothing to them; and
 * the consequence last because the next open is about to download everything again.
 */
export const STORAGE_RECOVERY_HEADLINE = "Your browser cleared some of EtherPK's data on this device to free up space."
export const STORAGE_RECOVERY_INTRO = 'Restored from local storage:'
export const STORAGE_RECOVERY_FOOTNOTE = 'Documents download again from the sync server when you next open a graph.'
/**
 * The workspace's closing line. The restore ran as part of this open, and the open found an
 * empty Local Cache and is already pulling the graph back from the server, so "when you next
 * open" would read as a refresh being needed when it is not.
 */
export const STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH =
    "This graph's documents are downloading again from the sync server in the background - no refresh is needed."

/**
 * One line per restored item, for the bulleted list. Graph recoveries carry names; passkey
 * recoveries carry graph ids, which `graphName` turns into a name where the caller has one.
 */
export function storageRecoveryItems(
    all: readonly StorageRecovery[],
    graphName: (graphId: string) => string | undefined = () => undefined,
): string[] {
    const items: string[] = []
    for (const entry of all) {
        for (const restored of entry.restored) {
            if (entry.kind === 'graphs') {
                items.push(`Synced graph "${restored}"`)
            } else {
                const name = graphName(restored)
                items.push(name ? `Passkey for protected documents in "${name}"` : 'Passkey for protected documents')
            }
        }
    }
    return items
}
