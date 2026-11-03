/**
 * Everything Ink adds to a graph, through the Extension API alone:
 *
 * - the widget over each ` ```ink.drawing ` fence, in the editor frame the Client draws
 *   (`frame: 'editor'`): a picture in the document, a board while it is edited, and the board
 *   filling a tab or the window, where the Client finds the drawing by its header's id;
 * - `/ink`, which puts a new, empty drawing at the caret, on every layout;
 * - the drawing's picture on a published site and in a quote of it (the Backlinks panel), white
 *   paper in either theme.
 *
 * The widget arrives as an argument, so this is tested in Node without compiling a component.
 * The fence keeps no history of its own: each stroke, erase and move is one editor change, so the
 * editor's undo and redo (Mod+Z, Mod+Y) take them back and forth.
 */
import type { CommandMenuContext, ExtensionContext, FenceWidget, PublishedFence } from '@appsoftwareltd/etherpk-extension-api'

import { identifyInk, INK_FENCE, inkAlt, newInkText, readInk } from './format'
import { inkPicture, svgMarkup } from './svg'

export const INSERT_COMMAND = 'ink.insert'

/** What `/ink` says when the caret's place cannot take a drawing. */
export const CANNOT_INSERT = "The drawing couldn't go there. Put the caret on a line of its own and try again."

/**
 * Whether `/ink` is offered: in a body that can be written, outside a table, and never in a
 * Protected Document, where no widget is drawn. On every layout, a phone's included.
 */
export function inkInsertOffered(menu: CommandMenuContext): boolean {
    return menu.bodyWritable && !menu.inTable && !menu.protectedDocument
}

/** A drawing as an SVG file, or null for one with nothing drawn (or made by a newer version). */
export function inkFile(body: readonly string[]): PublishedFence | null {
    const drawing = readInk(body)
    if (drawing.newer || drawing.strokes.length === 0) return null
    const picture = inkPicture(drawing)
    return {
        kind: 'picture',
        type: 'image/svg+xml',
        bytes: new TextEncoder().encode(svgMarkup(picture.root)),
        width: Math.round(picture.width),
        height: Math.round(picture.height),
        alt: inkAlt(drawing),
    }
}

export function registerInk(context: Pick<ExtensionContext, 'editor' | 'commands' | 'commandMenu' | 'notify'>, widget: FenceWidget): void {
    context.editor.registerFence(INK_FENCE, widget, {
        title: 'Ink drawing',
        frame: 'editor',
        identify: identifyInk,
        // White paper on a published site and in a quote alike, whatever the theme.
        publish: (fence) => inkFile(fence.body),
        quote: (fence) => inkFile(fence.body),
    })

    context.commands.register(INSERT_COMMAND, () => {
        if (!context.editor.insertBlock(newInkText(), { focus: true })) context.notify(CANNOT_INSERT)
    })

    context.commandMenu.register({
        id: INSERT_COMMAND,
        title: 'Ink (drawing)',
        detail: 'Insert an ink drawing for a pen or stylus',
        icon: 'ink',
        group: 'Insert',
        // After Excalidraw's drawing (117).
        order: 118,
        keywords: ['ink', 'draw', 'drawing', 'pen', 'stylus', 'handwriting', 'sketch', 'whiteboard'],
        when: inkInsertOffered,
        command: INSERT_COMMAND,
    })
}
