/**
 * Whether pictures from the network load in a [[Plain Folder]] (ADR 0197).
 *
 * A Plain Folder is often a cloned repository, written by someone else. A picture line with an
 * address (`![build](https://…)`) would be fetched as the file opens, which tells that address the
 * file was read, and from where. So remote pictures wait until the person says to load them, once
 * for the folder.
 *
 * The answer is kept in this browser, never in the folder: a folder that could grant itself trust
 * would grant it to whoever wrote it.
 */
import type { RemoteImagePolicy } from '../document/view/augmentations/image-embed'

const key = (folderId: string) => `etherpk-plain-remote-images:${folderId}`

/** The parts of `Storage` this reads and writes; `localStorage` in the browser. */
export type TrustStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createRemoteImageTrust(folderId: string, storage: TrustStorage): RemoteImagePolicy {
    const listeners = new Set<() => void>()
    // Held here too, so the answer stands for the visit where storage refuses a write (private mode).
    let granted = false
    try {
        granted = storage.getItem(key(folderId)) === '1'
    } catch {
        // Unreadable storage: remote pictures stay off until asked for.
    }
    return {
        allowed: () => granted,
        allow() {
            if (granted) return
            granted = true
            try {
                storage.setItem(key(folderId), '1')
            } catch {
                // Kept for this visit only.
            }
            for (const listener of listeners) listener()
        },
        onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

/** Forget the answer for a folder: when the folder itself is forgotten on this device. */
export function forgetRemoteImageTrust(folderId: string, storage: TrustStorage): void {
    try {
        storage.removeItem(key(folderId))
    } catch {
        // Nothing to forget.
    }
}
