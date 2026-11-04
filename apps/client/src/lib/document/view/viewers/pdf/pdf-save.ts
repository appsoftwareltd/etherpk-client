/**
 * **Save a copy**: new PDF bytes with a person's annotations, form values and signatures written in.
 * The Asset itself never changes.
 *
 * pdf.js writes the ordinary copy, as PDF annotations a recipient's editor can move or delete.
 * `@cantoo/pdf-lib`, loaded only when asked for, does the two things pdf.js cannot: draw annotations
 * into the page content (flattening), and remove or change the password. Flattening covers things up
 * and does not redact: text under a highlight stays in the file.
 */
import type { PDFDocument as PdfLibDocument, PDFPage } from '@cantoo/pdf-lib'

import { colourBytes, noteBox, SAVE_ENTRY_PREFIX, saveEntry } from '#lib/document/pdf/save-entries.js'
import { pressureOutline, smoothPath } from '#lib/document/pdf/pdf-geometry.js'
import type { PdfAnnotation } from '#lib/document/pdf/pdf-state.js'

import type { PdfDocument } from './pdf-library'
import { HIGHLIGHT_OPACITY, type PlacedSignature } from './pdf-overlay'

export type PasswordChoice = { mode: 'keep' } | { mode: 'remove' } | { mode: 'set'; password: string }

export interface SaveOptions {
    pdf: PdfDocument
    annotations: readonly PdfAnnotation[]
    signatures: readonly PlacedSignature[]
    flatten: boolean
    password: PasswordChoice
    /** The password that opened the PDF, when one did. */
    currentPassword: string | null
}

/** pdf.js's `AnnotationEditorType.STAMP`. */
const STAMP = 13

async function signatureEntry(signature: PlacedSignature): Promise<Record<string, unknown>> {
    const blob = await (await fetch(signature.url)).blob()
    return {
        annotationType: STAMP,
        bitmap: await createImageBitmap(blob),
        bitmapId: `signature-${signature.id}`,
        rect: [signature.x, signature.y, signature.x + signature.width, signature.y + signature.height],
        rotation: 0,
        pageIndex: signature.page - 1,
    }
}

/** Write the entries into pdf.js's storage for one save, then take them out again. */
async function pdfJsSave(options: SaveOptions, writeAnnotations: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const { pdf, annotations, signatures } = options
    if (!writeAnnotations) return pdf.saveDocument()
    const storage = pdf.annotationStorage
    const keys: string[] = []
    const put = (entry: Record<string, unknown>) => {
        const key = `${SAVE_ENTRY_PREFIX}etherpk_${keys.length}`
        storage.setValue(key, entry)
        keys.push(key)
    }
    for (const annotation of annotations) put(saveEntry(annotation, HIGHLIGHT_OPACITY))
    for (const signature of signatures) put(await signatureEntry(signature))
    try {
        return await pdf.saveDocument()
    } finally {
        for (const key of keys) storage.remove(key)
    }
}

async function flattenInto(doc: PdfLibDocument, annotations: readonly PdfAnnotation[], signatures: readonly PlacedSignature[]): Promise<void> {
    const lib = await import('@cantoo/pdf-lib')
    const font = await doc.embedFont(lib.StandardFonts.Helvetica)
    const pages = doc.getPages()
    const colour = (value: string) => {
        const [r, g, b] = colourBytes(value)
        return lib.rgb(r / 255, g / 255, b / 255)
    }
    const drawOne: Record<PdfAnnotation['kind'], (page: PDFPage, annotation: never) => Promise<void> | void> = {
        highlight: (page, annotation: Extract<PdfAnnotation, { kind: 'highlight' }>) => {
            const { quads } = annotation
            for (let i = 0; i + 7 < quads.length; i += 8) {
                const path = [0, 2, 6, 4].map((at, n) => `${n === 0 ? 'M' : 'L'}${quads[i + at]} ${-quads[i + at + 1]}`).join('')
                page.drawSvgPath(`${path}Z`, { x: 0, y: 0, color: colour(annotation.colour), opacity: HIGHLIGHT_OPACITY, blendMode: lib.BlendMode.Multiply })
            }
        },
        stroke: (page, annotation: Extract<PdfAnnotation, { kind: 'stroke' }>) => {
            // The curve the screen draws, with the page's y running up as pdf-lib's path does not.
            const points = annotation.points.map((value, i) => (i % 2 === 0 ? value : -value))
            if (annotation.pressures) {
                page.drawSvgPath(pressureOutline(points, annotation.pressures, annotation.width), { x: 0, y: 0, color: colour(annotation.colour) })
                return
            }
            page.drawSvgPath(smoothPath(points), {
                x: 0,
                y: 0,
                borderColor: colour(annotation.colour),
                borderWidth: annotation.width,
                borderLineCap: lib.LineCapStyle.Round,
                ...(annotation.tool === 'highlighter' ? { borderOpacity: HIGHLIGHT_OPACITY, blendMode: lib.BlendMode.Multiply } : {}),
            })
        },
        note: async (page, annotation: Extract<PdfAnnotation, { kind: 'note' }>) => {
            await drawNote(doc, page, font, annotation, colour(annotation.colour))
        },
    }
    for (const annotation of annotations) {
        const page = pages[annotation.page - 1]
        if (page) await drawOne[annotation.kind](page, annotation as never)
    }
    for (const signature of signatures) {
        const page = pages[signature.page - 1]
        if (!page) continue
        const image = await doc.embedPng(await (await fetch(signature.url)).arrayBuffer())
        page.drawImage(image, { x: signature.x, y: signature.y, width: signature.width, height: signature.height })
    }
    doc.getForm().flatten()
}

/** Text in the PDF's own font where it can be, and a picture of the text where it cannot. */
async function drawNote(
    doc: PdfLibDocument,
    page: PDFPage,
    font: Awaited<ReturnType<PdfLibDocument['embedFont']>>,
    note: Extract<PdfAnnotation, { kind: 'note' }>,
    color: ReturnType<typeof import('@cantoo/pdf-lib').rgb>,
): Promise<void> {
    try {
        page.drawText(note.text, { x: note.x, y: note.y - note.fontSize, size: note.fontSize, font, color, lineHeight: note.fontSize * 1.25 })
    } catch {
        // The Standard 14 fonts have no glyph for this text. A picture still shows it on the page.
        const [x1, y1, x2, y2] = noteBox(note)
        const image = await doc.embedPng(await notePicture(note, x2 - x1, y2 - y1))
        page.drawImage(image, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 })
    }
}

async function notePicture(note: Extract<PdfAnnotation, { kind: 'note' }>, width: number, height: number): Promise<ArrayBuffer> {
    const scale = 3
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser could not draw this note.')
    ctx.scale(scale, scale)
    ctx.fillStyle = note.colour
    ctx.font = `${note.fontSize}px sans-serif`
    ctx.textBaseline = 'top'
    note.text.split('\n').forEach((line, index) => ctx.fillText(line, 2, 2 + index * note.fontSize * 1.25))
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('The browser could not draw this note.')
    return blob.arrayBuffer()
}

/** What the copy is protected with once saved, or `null` for no password. */
function passwordAfter({ password, currentPassword }: SaveOptions): string | null {
    if (password.mode === 'set') return password.password
    return password.mode === 'remove' ? null : currentPassword
}

/** The bytes of the copy. */
export async function saveCopy(options: SaveOptions): Promise<Uint8Array<ArrayBuffer>> {
    const { flatten, password, currentPassword, annotations, signatures } = options
    const bytes = await pdfJsSave(options, !flatten)
    if (!flatten && password.mode === 'keep') return bytes
    const { PDFDocument } = await import('@cantoo/pdf-lib')
    const doc = await PDFDocument.load(bytes, currentPassword === null ? {} : { password: currentPassword })
    if (flatten) await flattenInto(doc, annotations, signatures)
    const next = passwordAfter(options)
    if (next !== null) doc.encrypt({ userPassword: next, ownerPassword: next })
    else if (currentPassword !== null) await dropEncryption(doc)
    return (await doc.save()) as Uint8Array<ArrayBuffer>
}

/**
 * Loading with a password decrypts the objects, but the file's encryption dictionary, and the old
 * trailer naming it, stay among them. Saved like that, the copy opens with the password still asked
 * for and then cannot be read, so both go.
 */
async function dropEncryption(doc: PdfLibDocument): Promise<void> {
    const { PDFDict, PDFInvalidObject, PDFName } = await import('@cantoo/pdf-lib')
    const standard = PDFName.of('Standard')
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
        // The parser keeps the old cross-reference stream, trailer and all, as an unread object.
        const staleTrailer = object instanceof PDFInvalidObject && object.toString().includes('/Encrypt')
        const encryptDict = object instanceof PDFDict && object.get(PDFName.of('Filter')) === standard
        if (staleTrailer || encryptDict) doc.context.delete(ref)
    }
}
