/**
 * A framed fence's image kept by the person (`asImage`, Proposed): a PNG on the clipboard or in a
 * download. The extension draws it, and the Client copies or downloads it and puts any failure into
 * words, so a person meets the same notices whichever extension drew the fence. Nothing is written
 * to the document.
 */
import type { FenceImage } from '@appsoftwareltd/etherpk-extension-api'

import { copyPngToClipboard } from '#lib/document/view/clipboard-image.js'
import { downloadBlob } from '#lib/native/save-file.js'

import { imageFailedNotice } from './fence-frame-core'

/** The fence said it could not be drawn, and why. */
class ImageNotDrawn extends Error {
    constructor(
        reason: string,
        readonly tryAgain: boolean,
    ) {
        super(reason)
    }
}

const DRAWING_FAILED = "It couldn't be drawn."

/**
 * Draw the fence's image and copy or save it. `draw` is called at once and a copy's clipboard write
 * starts at once, with the PNG to follow, because a browser allows that write only inside the
 * person's press. So call this from the press, with no `await` before it. Rejects with nothing kept.
 */
export function keepFenceImage(how: 'copy' | 'save', draw: () => Promise<FenceImage>): Promise<void> {
    let name = ''
    const png = new Promise<FenceImage>((resolve) => resolve(draw())).then((image) => {
        if (!image.drawn) throw new ImageNotDrawn(image.reason, image.tryAgain)
        name = image.name
        return new Blob([image.bytes as BlobPart], { type: 'image/png' })
    })
    if (how === 'copy') return copyPngToClipboard(png)
    return png.then((file) => downloadBlob(file, `${name}.png`))
}

/** What to tell the person about a failure, and whether pressing again may work. */
export function imageFailure(error: unknown, how: 'copy' | 'save', title: string | undefined): { text: string; tryAgain: boolean } {
    if (error instanceof ImageNotDrawn) return { text: imageFailedNotice(title, how, error.message), tryAgain: error.tryAgain }
    // The clipboard's own refusal, already in words (`clipboard-image.ts`).
    if (error instanceof Error && error.message.startsWith('Could not copy the image')) return { text: error.message, tryAgain: true }
    console.error("[extensions] a fence's image could not be drawn", error)
    return { text: imageFailedNotice(title, how, DRAWING_FAILED), tryAgain: true }
}
