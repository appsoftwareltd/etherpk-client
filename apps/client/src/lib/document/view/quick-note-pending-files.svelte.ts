/**
 * The files chosen for a [[Quick Note]] that is not added yet: held in memory, shown by
 * `QuickNoteBox`, and handed over whole when the note is added. Both surfaces that write a
 * note hold one (the Quick Notes View and the Share Target's page).
 *
 * A picture gets an object URL for its thumbnail, revoked when the file leaves the list, so a
 * long-lived tab does not keep every photo it was ever shown.
 */
import { isImageExt, splitNameExt } from '#lib/storage/fs/asset-store.js'

import type { QuickNoteBoxFile } from './QuickNoteBox.svelte'

interface Pending {
    shown: QuickNoteBoxFile
    file: File
}

/** A picture the Client draws, by the name the reference will carry: the same test a saved asset gets. */
function isPicture(file: File): boolean {
    return isImageExt(splitNameExt(file.name).ext)
}

export class PendingNoteFiles {
    #pending = $state.raw<Pending[]>([])

    /** What the box shows. */
    get shown(): QuickNoteBoxFile[] {
        return this.#pending.map((entry) => entry.shown)
    }

    get files(): File[] {
        return this.#pending.map((entry) => entry.file)
    }

    get count(): number {
        return this.#pending.length
    }

    add(files: readonly File[]): void {
        const added = files.map((file) => ({
            file,
            shown: {
                id: crypto.randomUUID(),
                name: file.name,
                size: file.size,
                ...(isPicture(file) ? { previewUrl: URL.createObjectURL(file) } : {}),
            },
        }))
        this.#pending = [...this.#pending, ...added]
    }

    remove(id: string): void {
        for (const entry of this.#pending) if (entry.shown.id === id) revoke(entry)
        this.#pending = this.#pending.filter((entry) => entry.shown.id !== id)
    }

    /** Empty the list and hand back its files: the note is being added, or the form started over. */
    take(): File[] {
        const files = this.files
        this.clear()
        return files
    }

    clear(): void {
        this.#pending.forEach(revoke)
        this.#pending = []
    }
}

function revoke(entry: Pending): void {
    if (entry.shown.previewUrl) URL.revokeObjectURL(entry.shown.previewUrl)
}
