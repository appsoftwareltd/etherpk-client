/**
 * The clipboard half of the paste upload route: which pasted files become [[Asset]]s, and what
 * an unnamed clipboard file is called. Pure functions over a `DataTransfer`-shaped value so the
 * rule is unit-tested without a DOM; the editor augmentation (`augmentations/asset-paste.ts`)
 * and the upload dialog both call these and then hand the files to the same upload path the
 * drag-and-drop and dialog routes use.
 */

import { isImageExt, splitNameExt } from '$lib/storage/fs/asset-store'

/** The slice of `DataTransfer` the rule reads. */
export interface ClipboardPayload {
    files: ArrayLike<File>
    types: readonly string[]
}

/**
 * The files to upload from a paste, or an empty array when the paste should fall through to
 * the editor's ordinary text paste.
 *
 * **Files win only when there is no plain text.** A screenshot, an image copied from a web
 * page (which also carries `text/html`) or a file copied from Finder or Explorer arrive with
 * no `text/plain`, so they upload. Cells copied from a spreadsheet, or a Word selection with
 * an inline picture, arrive with plain text *and* a rendered image of the selection; the user
 * wanted the text, so those paste as text and the picture is ignored.
 */
export function clipboardAssetFiles(data: ClipboardPayload | null | undefined): File[] {
    if (!data || data.files.length === 0) return []
    if (data.types.includes('text/plain')) return []
    return Array.from(data.files)
}

/**
 * True for the placeholder names browsers give clipboard data that never had a file name:
 * Chrome and Firefox hand a screenshot over as `image.png`, Safari sometimes as `image`, other
 * sources as `blob` or `clipboard`, and some as no name at all. A real file name (`holiday.png`,
 * `Q3 Report.pdf`) is anything else, and is kept exactly as drag-and-drop would keep it.
 */
export function isGenericClipboardName(name: string): boolean {
    const { stem } = splitNameExt(name)
    return stem.trim() === '' || GENERIC_STEMS.has(stem.trim().toLowerCase())
}

const GENERIC_STEMS = new Set(['image', 'file', 'blob', 'clipboard'])

/**
 * The file to upload for a pasted clipboard file: the file itself when it carries a real name,
 * otherwise a copy named `image-YYYY-MM-DD-HH-MM-SS.<ext>` (or `file-…` for a non-image) in
 * local time, so the assets folder sorts by when things were captured and the alt text tells
 * the reader what it is. The content hash still dedups identical bytes whatever the stem.
 */
export function nameClipboardFile(file: File, now: Date = new Date()): File {
    if (!isGenericClipboardName(file.name)) return file
    const ext = extensionFor(file)
    const kind = isImageExt(ext) || file.type.startsWith('image/') ? 'image' : 'file'
    return new File([file], `${kind}-${timestamp(now)}.${ext}`, { type: file.type, lastModified: file.lastModified })
}

/** The name's own extension when it has one, else one implied by the MIME type, else `bin`. */
function extensionFor(file: File): string {
    const { ext } = splitNameExt(file.name)
    if (ext) return ext
    const known = MIME_EXT[file.type]
    if (known) return known
    const subtype = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '')
    return subtype || 'bin'
}

/** Extensions for the MIME types whose subtype is not already the conventional extension. */
const MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/octet-stream': 'bin',
}

/** `navigator.clipboard.read()` was refused (no permission, or the browser withheld it). */
export class ClipboardAccessRefused extends Error {
    readonly name = 'ClipboardAccessRefused'
}

/**
 * Read image files off the clipboard through the Async Clipboard API - the upload dialog's
 * **Paste from clipboard** button, which exists for touch devices, where no paste *event*
 * ever fires. The API yields images and text only, never an arbitrary copied file, so a
 * copied PDF still needs Ctrl+V on a desktop; the dialog's help text says as much. Each
 * image item becomes one timestamp-named File (PNG preferred when an item offers several
 * encodings); a text-only clipboard yields an empty list rather than an error.
 */
export async function readClipboardImages(clipboard: Pick<Clipboard, 'read'>, now: Date = new Date()): Promise<File[]> {
    let items: ClipboardItems
    try {
        items = await clipboard.read()
    } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            throw new ClipboardAccessRefused('Clipboard access was refused.')
        }
        throw err
    }
    const files: File[] = []
    for (const item of items) {
        const type = item.types.includes('image/png') ? 'image/png' : item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        files.push(nameClipboardFile(new File([blob], '', { type }), now))
    }
    return files
}

function timestamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
