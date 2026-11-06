/**
 * Excalidraw drawings in EtherPK documents, kept as data in the document. A Built-in Extension
 * compiled into the Client (ADR 0121), which calls `activate` as each graph opens.
 *
 * A drawing is an Extension Fence (` ```excalidraw.drawing `, `format.ts`): EtherPK never searches its
 * lines, never shows them unless asked, and never publishes them as text. Through the EtherPK
 * Extension API the extension adds:
 *
 * - a widget over each drawing fence (`context.editor.registerFence`), a picture that turns into a
 *   live Excalidraw editor when pressed, in its place on a desktop with a mouse or a trackpad, and
 *   over the window on a phone or a touch screen (`widget.ts`), saving as the person draws, in
 *   the Client's editor frame (`frame: 'editor'`), whose toolbar and menu offer Done, Full window,
 *   Open in tab, Edit as text and Delete;
 * - Open in tab and Full window, where the Client draws the same widget bigger (the fence's
 *   `identify` lets the Client find the drawing again by its own id);
 * - `/drawing`, on every layout, which puts a new drawing at the caret (`context.editor.insertBlock`);
 * - pasted on a line of its own, an excalidraw.com share link becomes a drawing to import, and shapes
 *   copied on excalidraw.com become a drawing of them (the fence's `fromPaste`, `share-link.ts`);
 * - images to draw over, kept as the graph's Assets (`images.ts`, `editor.ts`);
 * - on a published site, a picture of the drawing (the fence's `publish`);
 * - where a reference quotes the drawing, in the Backlinks panel and beneath a document, the same
 *   picture (the fence's `quote`);
 * - as a PNG a person copies or saves, from the frame's menu over the picture (the fence's `asImage`)
 *   or from Excalidraw's own dialog while the drawing is edited.
 *
 * A drawing is drawn light in either of the app's themes, its editor and its pictures alike, so it
 * shows the colours it holds: Excalidraw's dark mode inverts them as it draws.
 *
 * Compiled in, it mounts in the page rather than in a shadow root, which Excalidraw needs: its copy
 * and paste and its dialogs do not work inside one. Its own stylesheet (`styles.css`) styles only
 * classes starting with `excalidraw`, and Excalidraw's, which arrives with Excalidraw (`load.ts`),
 * is scoped under them by the Client's build (`build-plugins/vite-plugins.ts`), so neither
 * restyles the Client.
 */
import './styles.css'

import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { drawingImage } from './drawing-image'
import { DRAWING_FENCE, identifyDrawing, newDrawingText } from './format'
import { createImageAccess } from './images'
import { drawingPicture } from './published-picture'
import { pastedDrawing } from './share-link'
import { createDrawingWidget, imagesLeftOut } from './widget'

export const INSERT_COMMAND = 'excalidraw.insert'

/** Whether the main pointer is a finger or a stylus (a tablet's), rather than a mouse or a trackpad. */
function touchFirst(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export function activate(context: ExtensionContext): void {
    const images = createImageAccess(context.assets)
    const widget = createDrawingWidget({ editsInPlace: () => context.layout.isDesktop() && !touchFirst(), notify: (message) => context.notify(message), images })
    context.editor.registerFence(DRAWING_FENCE, widget, {
        title: 'Drawing',
        // The Client draws the toolbar and the menu round the drawing, and edits one drawing at a time.
        frame: 'editor',
        keepsHistory: true,
        identify: identifyDrawing,
        fromPaste(text) {
            const pasted = pastedDrawing(text)
            if (!pasted) return null
            if (pasted.skippedImages > 0) context.notify(imagesLeftOut(pasted.skippedImages, 'pasted'))
            return pasted.lines
        },
        publish: (fence) => drawingPicture(fence.body, { read: images.read, requireImages: true }),
        quote: (fence) => drawingPicture(fence.body, { read: images.read }),
        asImage: (fence) => drawingImage(fence, images.read),
    })

    context.commands.register(INSERT_COMMAND, () => {
        if (!context.editor.insertBlock(newDrawingText(), { focus: true })) {
            context.notify("The drawing couldn't go there. Put the caret on a line of its own and try again.")
        }
    })

    context.commandMenu.register({
        id: INSERT_COMMAND,
        title: 'Excalidraw (drawing)',
        detail: 'Insert an Excalidraw drawing',
        icon: 'drawing',
        group: 'Insert',
        // After Map (115) and Video (116).
        order: 117,
        keywords: ['excalidraw', 'draw', 'drawing', 'sketch', 'diagram', 'whiteboard', 'canvas'],
        // On every layout, a phone's included, and never in a Protected Document, which draws none.
        when: (menu) => menu.bodyWritable && !menu.inTable && !menu.protectedDocument,
        command: INSERT_COMMAND,
    })
}
