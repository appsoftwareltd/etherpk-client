/**
 * Augmentation: a [[Rich Paste]] (CONTEXT.md; ADR 0090). When the clipboard carries `text/html`,
 * the HTML becomes the document's markdown (`html-blocks.ts`) and lands as an ordinary paste, so
 * the block-per-line rule (`paste-clamp.ts`) shapes it; every image the selection carried is
 * written as a remote link and, where the browser can read it, stored as an [[Asset]] and its
 * reference rewritten as it lands (`remote-image-upload.ts`).
 *
 * Runs after `asset-paste.ts` in the feature stack: clipboard files with no plain text beside them
 * are that route's, so a copied picture still uploads as a picture. Yields (returns false) when
 * there is no HTML, when the caret is in a fenced block or the frontmatter, or when the HTML holds
 * nothing to paste, and the editor's own text paste applies.
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import { defaultMaxImageDisplaySize } from '../asset-upload'
import { RICH_PASTE_USER_EVENT } from '../editor-history'
import { addPastedRange, pastedRangesField, startRemoteImageUpload } from '../remote-image-upload'
import { parseHtml, planRichPaste } from '../rich-paste'

/** Each paste's range gets its own id, so its uploads find their own references and no other. */
let nextPasteId = 1

/** The span the transaction's changes inserted, in the document they produced. */
function insertedRange(tr: { changes: { iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void } }): { from: number; to: number } {
    let from = Number.POSITIVE_INFINITY
    let to = 0
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        from = Math.min(from, fromB)
        to = Math.max(to, toB)
    })
    return { from: Number.isFinite(from) ? from : 0, to }
}

export interface RichPasteOptions {
    /** The active asset store, or `null` when no graph is open: with none, the images stay remote. */
    store: () => AssetStore | null
    /** Test seam: the HTML parser. Defaults to the browser's `DOMParser`. */
    parse?: (html: string) => Document
}

export function richPasteAugmentation(options: RichPasteOptions): Extension {
    const handlers = EditorView.domEventHandlers({
        paste(event, view) {
            const html = event.clipboardData?.getData('text/html') ?? ''
            if (html.trim() === '') return false
            const plan = planRichPaste(view.state, html, options.parse ?? parseHtml, defaultMaxImageDisplaySize())
            if (!plan) return false
            event.preventDefault()
            const id = nextPasteId++
            // The paste opens the undo step its rewrites join (its user event, editor-history.ts), and records
            // where it landed: the range is read back from the change the transaction makes, since the paste
            // filter may reshape the text and move where it starts.
            const tr = view.state.update(view.state.replaceSelection(plan.text), { userEvent: RICH_PASTE_USER_EVENT, scrollIntoView: true })
            view.dispatch(tr)
            view.dispatch({ effects: addPastedRange.of({ id, ...insertedRange(tr) }) })
            const store = options.store()
            // Runs as an Activity, so progress and any failure reach an [[Activity Toast]].
            if (store && plan.images.length > 0) void startRemoteImageUpload(view, store, plan.images, { pasteId: id })
            return true
        },
    })
    return [pastedRangesField, handlers]
}
