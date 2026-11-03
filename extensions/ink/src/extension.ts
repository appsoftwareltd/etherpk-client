/**
 * Ink: freehand drawings for a pen or stylus, kept in the document as one line of text per stroke
 * (`format.ts`). Compiled into the Client (ADR 0121) and built on the Extension API alone, with
 * perfect-freehand for the ink's shape.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { registerInk } from './register'
import { DEFAULT_COLUMN_WIDTH } from './sizes'
import { createInkWidget } from './widget.svelte'

export function activate(context: ExtensionContext): void {
    const widget = createInkWidget({
        icons: context.icons,
        storage: context.storage,
        isDesktop: () => context.layout.isDesktop(),
        columnWidth: DEFAULT_COLUMN_WIDTH,
    })
    registerInk(context, widget)
}
