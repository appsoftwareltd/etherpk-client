/**
 * The rules of the **editor frame** (`frame: 'editor'` on a fence registration, Proposed): the
 * frame the Client draws round a fence that is a picture until it is edited in the document, such as
 * a drawing. Kept apart from the DOM (`fence-frame.ts`) so every rule is checked in Node.
 *
 * - **One fence is edited at a time**, in all the documents open. Starting one stops the one before,
 *   which writes what it holds first (`EditingRegistry`).
 * - **Which actions show where**: a toolbar while the fence is edited in the document, a menu over
 *   its picture otherwise, and nothing in a tab or a window. Where the document cannot be written the
 *   menu holds only what leaves the document as it is: a fence's image (`frameActions`).
 */
import type { FencePresentation } from '@appsoftwareltd/etherpk-extension-api'

/** The toolbar's height in CSS pixels, added to the widget's own while the fence is edited. */
export const FRAME_TOOLBAR_HEIGHT = 44

/**
 * Which fence a framed widget draws, for the editing state, where the editor cannot say where it
 * draws the fence (`fenceInstance`): the document and the fence's own id (`identify`), so it
 * outlasts edits to the fence and its widget being drawn again. Null for a fence with no id.
 */
export function frameKey(document: string | null, id: string | null): string | null {
    return id === null || id === '' ? null : `${document ?? ''}\n${id}`
}

export interface EditingRegistry {
    /** Whether the fence with this key is edited now. */
    isEditing(key: string): boolean
    /**
     * Start editing `key`. The fence edited before, if another, is stopped first: its `stop` runs,
     * which writes what its widget holds and then calls `end`.
     */
    start(key: string, stop: () => void): void
    /** Stop editing `key`. Does nothing when it is not the fence edited now. */
    end(key: string): void
    /** Hear every start and end. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
}

export function createEditingRegistry(): EditingRegistry {
    let current: { key: string; stop: () => void } | null = null
    const listeners = new Set<() => void>()
    const changed = () => {
        for (const listener of [...listeners]) listener()
    }
    return {
        isEditing: (key) => current?.key === key,
        start(key, stop) {
            if (current?.key === key) {
                current = { key, stop }
                return
            }
            // The stop writes what the other widget holds and calls end. This fence starts whether
            // or not it did, so one that throws cannot keep the others from being edited.
            try {
                current?.stop()
            } catch (error) {
                console.error('[extensions] stopping the fence edited before threw', error)
            }
            current = { key, stop }
            changed()
        },
        end(key) {
            if (current?.key !== key) return
            current = null
            changed()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}

/** The registry the Client's framed fences share. */
export const frameEditing = createEditingRegistry()

export type FrameAction = 'done' | 'full-window' | 'open-tab' | 'copy-image' | 'save-image' | 'edit-as-text' | 'delete'

export interface FrameState {
    presentation: FencePresentation
    /** Whether the document accepts changes now. */
    writable: boolean
    /** Whether the fence is edited in the document now. */
    editing: boolean
    /** Whether the fence has an id (`identify`), which a tab and the full window need. */
    identified: boolean
    /** Whether the fence can be drawn as an image (`asImage`). */
    image: boolean
    /** Whether this browser's clipboard can take an image. */
    copies: boolean
}

/**
 * The actions the frame shows: the toolbar's, while the fence is edited in the document, where Edit
 * as text and Delete stand apart from the actions that move the fence (`apart`); and the menu's over
 * the picture otherwise. None in a tab or a window, which has the Client's own Return. Where the
 * document cannot be written, the menu holds only the fence's image, which changes nothing. While the
 * fence is edited its widget offers its own way to the image, if it has one, so the toolbar does not.
 */
export function frameActions(state: FrameState): { toolbar: FrameAction[]; apart: FrameAction[]; menu: FrameAction[] } {
    const none = { toolbar: [], apart: [], menu: [] }
    if (state.presentation !== 'inline') return none
    const image: FrameAction[] = !state.image ? [] : state.copies ? ['copy-image', 'save-image'] : ['save-image']
    if (!state.writable) return { ...none, menu: image }
    if (!state.editing) return { ...none, menu: [...image, 'edit-as-text', 'delete'] }
    return { toolbar: state.identified ? ['done', 'full-window', 'open-tab'] : ['done'], apart: ['edit-as-text', 'delete'], menu: [] }
}

/** Each action's label, as its button and menu item say it. */
export const FRAME_ACTION_LABELS: Readonly<Record<FrameAction, string>> = {
    done: 'Done',
    'full-window': 'Full window',
    'open-tab': 'Open in tab',
    'copy-image': 'Copy as image',
    'save-image': 'Save as image',
    'edit-as-text': 'Edit as text',
    delete: 'Delete',
}

/** Whether a menu item leaves the fence as it was, so the keyboard goes back to the menu's button. */
export function keepsMenuFocus(action: FrameAction): boolean {
    return action === 'copy-image' || action === 'save-image'
}

/** What the person is told once a fence is on the clipboard, which they cannot see. */
export function imageCopiedNotice(title: string | undefined): string {
    return `${title ?? 'Block'} copied as an image.`
}

/** What the person is told when a fence's image could not be copied or saved, with the fence's own reason. */
export function imageFailedNotice(title: string | undefined, how: 'copy' | 'save', reason: string): string {
    return `The ${(title ?? 'Block').toLowerCase()} couldn't be ${how === 'copy' ? 'copied' : 'saved'} as an image. ${reason}`
}

/** What the person is told after Delete, which takes the fence out without asking first. */
export function deletedNotice(title: string | undefined): string {
    return `${title ?? 'Block'} deleted. Press Ctrl+Z (Cmd+Z on a Mac) in the document to bring it back.`
}
