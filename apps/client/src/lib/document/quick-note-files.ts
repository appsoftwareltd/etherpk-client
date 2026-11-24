/**
 * Files in a [[Quick Note]] (ADR 0186): a photo, a PDF or any other file shared or attached to
 * a note is an [[Asset]], and the note's text holds its [[Asset Reference]] on a line of its own.
 *
 * The reference is the document format's own, and nothing about the file is a field on the note.
 * The move to the journal writes each file's line as a bullet nested under the note
 * (`quick-notes-journal.ts`), so a picture shows there and a [[Task]] holds its files.
 *
 * Pure over text: what a note's text is once its files are stored, how the Quick Notes View
 * reads a note back as text, pictures and files, and which assets a note references.
 */
import { assetNameFromRef, buildAssetMarkdown, displayNameForRef, isImageAssetRef } from '#lib/storage/fs/asset-store.js'

import { MARKDOWN_LINK, linkGroups, markdownLinks } from './markdown-link-target'

/** What a stored file is to the note: enough of a `SavedAsset` to write its reference. */
export interface NoteFile {
    ref: string
    stem: string
    isImage: boolean
}

/**
 * The note's text with its files: what the person wrote, then each file's reference on its own
 * line. A note that is only files starts with the first reference, which the move writes as the
 * bullet's own content. `imageSize` is the graph's default display size for a picture.
 */
export function noteTextWithFiles(text: string, files: readonly NoteFile[], imageSize?: string): string {
    const lines = files.map((file) => buildAssetMarkdown(file, file.isImage ? imageSize : undefined))
    return [text.trim(), ...lines].filter((part) => part !== '').join('\n')
}

/**
 * A checkbox at the start of a note, open or done, with or without a space after it: the editor's
 * own task rule (`taskDone` in block-model.ts), less the bullet the move writes. The spaces after
 * it go with it, and so does the line break when the checkbox stands alone on its line.
 */
const LEADING_CHECKBOX = /^\[([ xX])\][ \t]*\n?/

/**
 * Whether a note is a [[Task]], and its text without the checkbox. The checkbox is the note's own
 * text (`shareNoteText`), so the move to the journal writes it as it is; the Quick Notes View
 * draws it as a box in front of the text. Null for a note that does not start with one.
 */
export function quickNoteTask(text: string): { done: boolean; text: string } | null {
    const match = LEADING_CHECKBOX.exec(text)
    return match ? { done: match[1] !== ' ', text: text.slice(match[0].length) } : null
}

/** One run of a note as the Quick Notes View shows it. */
export type QuickNotePart =
    | { kind: 'text'; text: string }
    | { kind: 'image'; url: string; alt: string }
    | { kind: 'file'; url: string; name: string }

const WHOLE_LINE_LINK = new RegExp(`^\\s*${MARKDOWN_LINK}\\s*$`)

/** The asset reference a line is nothing but, or null: a line of prose that links a file stays text. */
function fileLine(line: string): QuickNotePart | null {
    const match = WHOLE_LINE_LINK.exec(line)
    if (!match) return null
    const { bang, label, target } = linkGroups(match)
    if (assetNameFromRef(target) === null) return null
    if (bang === '!' && isImageAssetRef(target)) return { kind: 'image', url: target, alt: label }
    return { kind: 'file', url: target, name: displayNameForRef(target) }
}

/** Whether a line of a note is nothing but one file's reference: what the move nests under the note. */
export function isNoteFileLine(line: string): boolean {
    return fileLine(line) !== null
}

/**
 * A note's text as text, pictures and files, in the order written. Lines of text between two
 * files stay together as one part, line breaks kept.
 */
export function quickNoteParts(text: string): QuickNotePart[] {
    const parts: QuickNotePart[] = []
    let run: string[] = []
    const flush = () => {
        if (run.length > 0) parts.push({ kind: 'text', text: run.join('\n') })
        run = []
    }
    for (const line of text.split('\n')) {
        const file = fileLine(line)
        if (file) {
            flush()
            parts.push(file)
        } else {
            run.push(line)
        }
    }
    flush()
    return parts
}

/** Every asset reference in a note's text, each once: what deleting the note may leave unreferenced. */
export function quickNoteAssetRefs(text: string): string[] {
    const refs = new Set<string>()
    for (const link of markdownLinks(text)) {
        if (assetNameFromRef(link.target) !== null) refs.add(link.target)
    }
    return [...refs]
}
