/**
 * Augmentation: drag-and-drop a file onto the editor to upload it and embed its
 * reference at the drop point. The editor already shows a drop caret (`dropCursor()`
 * in cm-document.ts); this handles the actual drop. Image files render inline,
 * everything else becomes a download link (see {@link uploadAndInsert}).
 *
 * No-ops (returns false, letting CodeMirror's default text drop through) when the
 * drag carries no files or no asset store is active.
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { startAssetUpload } from '../upload-activity'

export interface AssetDropOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
}

export function assetDropAugmentation(options: AssetDropOptions): Extension {
    return EditorView.domEventHandlers({
        drop(event, view) {
            const files = event.dataTransfer?.files
            if (!files || files.length === 0) return false
            const store = options.store()
            if (!store) return false
            event.preventDefault()
            const pos =
                view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
            // Runs as an Activity, so progress and any failure reach an [[Activity Toast]].
            // This used to be `void uploadAndInsert(...)`, which discarded the rejection
            // as well as the promise - a failed drop was completely silent.
            void startAssetUpload(view, store, [...files], pos)
            return true
        },
    })
}
