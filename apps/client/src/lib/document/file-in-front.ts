/**
 * Which file's tab is in front, and what a viewer can say about it, for an extension to ask
 * (`context.layout.activeFile`). The workspace says which tab is in front, as the main region's active
 * tab changes, and a viewer with text to select says what is selected, while it is open.
 */
import { editorContext } from './editor-context.svelte'

/** The text selected in a file, read at one moment. */
export interface FileSelection {
    selectedText: string
    restoreSelection(): void
}

const NOTHING_SELECTED: FileSelection = { selectedText: '', restoreSelection() {} }

let front: string | null = null
const viewers = new Map<string, () => FileSelection>()

/** A file's type from a tab's target, which ends with the file's own extension. */
export function fileTypeOf(target: string): string {
    return /\.([a-z0-9]{1,10})$/i.exec(target)?.[1].toLowerCase() ?? ''
}

/** The main region's active tab became this file, or null for a document or no tab. */
export function noteFileInFront(target: string | null): void {
    front = target
    editorContext.fileInFront = target === null ? null : fileTypeOf(target)
}

/** A viewer can answer for this file while it is open. Returns the function that takes that back. */
export function registerFileSelection(target: string, read: () => FileSelection): () => void {
    viewers.set(target, read)
    return () => {
        if (viewers.get(target) === read) viewers.delete(target)
    }
}

/** The file in front, as `context.layout.activeFile` answers. */
export function activeFile(): (FileSelection & { type: string }) | null {
    if (front === null) return null
    return { type: fileTypeOf(front), ...(viewers.get(front)?.() ?? NOTHING_SELECTED) }
}
