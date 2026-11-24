/**
 * Printing a document or a drawing: the HTML from `render-for-print.ts` made safe and made whole, its
 * pictures found, and shown to the browser's dialog (`print-window.ts`). Browser-only.
 */
import { sanitizedPrintFragment } from '#lib/security/trusted-types.js'

import { mediaKindOfTarget } from '../media-line'

import { printContainer, type PrintOutcome } from './print-window'
import { omittedLine, type PrintableDocument, type PrintEnvironment, renderForPrint } from './render-for-print'

export interface PrintDocumentDeps {
    environment: PrintEnvironment
    /**
     * Where a picture the document shows is, by its reference as written, or null when it cannot be
     * had: missing, not on this device, or a picture from the web this folder does not load.
     */
    picture(reference: string): Promise<string | null>
    /** Called as the dialog is about to open. */
    onReady?: () => void
}

/** Characters no file system takes in a name, and the control characters. */
// eslint-disable-next-line no-control-regex -- a control character in a page's name is what this takes out
const NOT_IN_A_NAME = /[\\/:*?"<>|\u0000-\u001f]+/g

/** The name a saved PDF is offered under, without its `.pdf`. */
export function printFileName(name: string): string {
    return name.replace(NOT_IN_A_NAME, ' ').replace(/\s+/g, ' ').trim() || 'EtherPK'
}

/** A picture that could not be had, by the name a person would know it by. */
export function missingPictureLine(reference: string, alt: string): string {
    const file = reference.split(/[?#]/)[0].split('/').pop() ?? reference
    let name = file
    try {
        name = decodeURIComponent(file)
    } catch {
        // Not an encoded name: it is shown as it is.
    }
    return `"${alt.trim() || name}" did not load and is not in the print. Print again once the picture shows in the document.`
}

/** Print a document. Resolves when the dialog has closed. */
export async function printDocument(document: PrintableDocument, deps: PrintDocumentDeps): Promise<PrintOutcome> {
    const { html, pictures, hasMath } = await renderForPrint(document, deps.environment)
    const held = new ObjectUrls()
    try {
        const container = globalThis.document.createElement('div')
        container.className = 'etherpk-print-document'
        const fragment = sanitizedPrintFragment(html)
        plainLinks(fragment)
        await findPictures(fragment, document.name, async (reference) => {
            const drawn = pictures.get(reference)
            return drawn ? held.of(drawn.bytes, drawn.type) : deps.picture(reference)
        })
        container.append(fragment)
        if (hasMath) await loadMathFonts()
        return await printContainer({ container, title: printFileName(document.name), onReady: deps.onReady })
    } finally {
        held.release()
    }
}

/** Print one picture: a drawing in a tab of its own. */
export async function printPicture(
    picture: { bytes: Uint8Array; type: string; alt: string; width: number; height: number },
    options: { name: string; onReady?: () => void },
): Promise<PrintOutcome> {
    const held = new ObjectUrls()
    try {
        const container = document.createElement('div')
        container.className = 'etherpk-print-drawing'
        const image = document.createElement('img')
        image.src = held.of(picture.bytes, picture.type)
        image.alt = picture.alt
        image.width = picture.width
        image.height = picture.height
        container.append(image)
        return await printContainer({ container, title: printFileName(options.name), onReady: options.onReady })
    } finally {
        held.release()
    }
}

/** A link that opens nothing from paper or from a PDF someone else reads is its words. A web link stays. */
export function plainLinks(root: ParentNode): void {
    for (const link of root.querySelectorAll('a')) {
        if (/^(https?|mailto):/i.test(link.getAttribute('href') ?? '')) continue
        link.replaceWith(...link.childNodes)
    }
}

/** Give each picture its address. One that cannot be had, and one that is a recording, is a line in its place. */
async function findPictures(root: ParentNode, name: string, find: (reference: string) => Promise<string | null>): Promise<void> {
    await Promise.all(
        [...root.querySelectorAll('img')].map(async (image) => {
            const reference = image.getAttribute('src') ?? ''
            const media = mediaKindOfTarget(reference)
            if (media !== null) return image.replaceWith(line(omittedLine({ kind: media, name: image.alt || reference }, name)))
            const url = await find(reference).catch(() => null)
            const shown = url !== null && (await loads(url))
            if (!shown) return image.replaceWith(line(missingPictureLine(reference, image.alt)))
            // Asked for at once: a picture that waits to be scrolled to is never asked for in print.
            image.removeAttribute('loading')
            image.src = url
        }),
    )
}

/** Whether the browser can draw the picture at `url`. */
async function loads(url: string): Promise<boolean> {
    const probe = new Image()
    probe.src = url
    return probe.decode().then(
        () => true,
        () => false,
    )
}

function line(text: string): HTMLElement {
    const element = document.createElement('span')
    element.className = 'etherpk-print-left-out'
    element.textContent = text
    return element
}

/** KaTeX's faces are asked for by what is drawn, and nothing in the container is drawn until it prints. */
async function loadMathFonts(): Promise<void> {
    await import('katex/dist/katex.min.css')
    const faces = [...document.fonts].filter((face) => face.family.replace(/["']/g, '').startsWith('KaTeX'))
    await Promise.all(faces.map((face) => face.load().catch(() => {})))
}

class ObjectUrls {
    private readonly urls: string[] = []

    of(bytes: Uint8Array, type: string): string {
        const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
        this.urls.push(url)
        return url
    }

    release(): void {
        for (const url of this.urls) URL.revokeObjectURL(url)
    }
}
