/**
 * `context.editor.openPanel` (ADR 0147): an extension's panel beneath a line of the editor the person
 * is working in, as the editor's inline panels draw it (`inline-panels.ts`).
 */
import type { InlinePanel, InlinePanelOptions } from '@appsoftwareltd/etherpk-extension-api'
import type { EditorView } from '@codemirror/view'

import { type InlinePanelHandle, openInlinePanel } from '$lib/document/view/augmentations/inline-panels'

export function openExtensionPanel(view: EditorView | null, options: InlinePanelOptions & { at?: 'caret' | 'end' | 'caret-or-end' }): InlinePanel | null {
    if (!view) return null
    let handle: InlinePanelHandle | null = null
    // Made before the panel opens: the editor draws it inside the very dispatch that opens it, and
    // the extension is handed this object then.
    const panel: InlinePanel = {
        get document() {
            return handle?.document() ?? null
        },
        get isOpen() {
            return handle?.isOpen ?? false
        },
        insertBlock: (text) => handle?.insertBlock(text) ?? false,
        focus: () => handle?.focus(),
        resize: (height) => handle?.resize(height),
        outline: () => handle?.outline() ?? null,
        close: () => handle?.close(),
    }
    handle = openInlinePanel(view, {
        at: options.at ?? 'caret',
        height: options.height,
        mount: (host) => options.mount(host, panel),
        onClose: () => options.onClose?.(),
    })
    return handle ? panel : null
}
