/**
 * Augmentation: paste clipboard files into the editor to upload them and embed their
 * references at the caret - the third upload route beside drag-and-drop ({@link assetDropAugmentation})
 * and the `asset.upload` dialog. Image files render inline, everything else becomes a
 * download link (see {@link uploadAndInsert}); a file with no real name (a screenshot) is
 * named by its capture time ({@link nameClipboardFile}).
 *
 * No-ops (returns false, letting CodeMirror's default text paste through) when the paste
 * should be text - the rule is {@link clipboardAssetFiles}: files win only when there is no
 * plain text on the clipboard - or when no asset store is active.
 *
 * A selection is **replaced**, as Ctrl+V means: the range is deleted in one transaction and
 * the upload starts at its start. A failed upload therefore leaves the text gone, but a
 * single undo restores it and the [[Activity Toast]] reports the failure.
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { clipboardAssetFiles, nameClipboardFile } from '../clipboard-assets'
import { startAssetUpload } from '../upload-activity'

export interface AssetPasteOptions {
    /** The active asset store, or `null` when no graph is open. */
    store: () => AssetStore | null
}

export function assetPasteAugmentation(options: AssetPasteOptions): Extension {
    return EditorView.domEventHandlers({
        paste(event, view) {
            const files = clipboardAssetFiles(event.clipboardData)
            if (files.length === 0) return false
            const store = options.store()
            if (!store) return false
            event.preventDefault()
            const { from, to } = view.state.selection.main
            if (from !== to) {
                view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete' })
            }
            // Runs as an Activity, so progress and any failure reach an [[Activity Toast]].
            void startAssetUpload(view, store, files.map((f) => nameClipboardFile(f)), from)
            return true
        },
    })
}
