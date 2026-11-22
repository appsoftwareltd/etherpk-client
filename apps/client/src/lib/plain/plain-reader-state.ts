/**
 * A PDF's annotations and an EBook's highlights in a [[Plain Folder]], kept as items of its hidden
 * `.etherpk` folder (plain-state-folder.ts, ADR 0197): one file for each highlight, so two people's
 * highlights on one PDF are two files and merge in git.
 *
 * **An item names its file twice**, by path and by the hash of its bytes. A file that was moved or
 * renamed is found again by its hash, and one that was edited by its path. An item that matches
 * neither stays in the folder untouched.
 *
 * The place a person has read to stays on the device, as it does for a Folder graph.
 */
import type { EbookDeviceMemory } from '../document/ebook/ebook-device-memory'
import { type EbookHighlight, type EbookState, type EbookStateHost, type EbookStateStore, sanitizeEbookHighlight } from '../document/ebook/ebook-state'
import type { PdfDeviceMemory } from '../document/pdf/device-memory'
import { type FormValue, type PdfAnnotation, type PdfState, type PdfStateHost, type PdfStateStore, sanitizeAnnotation } from '../document/pdf/pdf-state'

import { type PlainStateFolder, isStateId } from './plain-state-folder'

/** The file an item is about. */
export interface FileRef {
    path: string
    hash: string
}

export const PDF_ANNOTATIONS = 'pdf-annotations'
export const PDF_FORMS = 'pdf-forms'
export const EBOOK_HIGHLIGHTS = 'ebook-highlights'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file an item says it is about, or null when it does not say. */
export function fileOfItem(value: unknown): FileRef | null {
    if (!isRecord(value) || !isRecord(value.file)) return null
    const { path, hash } = value.file
    return typeof path === 'string' && typeof hash === 'string' ? { path, hash } : null
}

/** Whether an item is about `file`: the same bytes wherever they now are, or the same place whatever it now holds. */
export function isAbout(value: unknown, file: FileRef): boolean {
    const of = fileOfItem(value)
    return of !== null && (of.hash === file.hash || of.path === file.path)
}

/** What a store of either reader shares: listeners, and writes that report a failure instead of losing it. */
function saving(folder: PlainStateFolder, what: string) {
    const listeners = new Set<() => void>()
    let refused: string | null = null
    let pending: Promise<unknown> = Promise.resolve()
    const changed = () => {
        for (const listener of listeners) listener()
    }
    return {
        listeners,
        changed,
        problem: () => refused,
        /** Run a write to the folder, after the ones before it. */
        save(work: () => Promise<void>): void {
            pending = pending.then(work).catch((error: unknown) => {
                refused = `Changes to this ${what} could not be saved to the folder’s .etherpk folder (${error instanceof Error ? error.message : String(error)}).`
                changed()
            })
        },
        settled: () => pending,
        folder,
    }
}

export interface PlainReaderStateDeps {
    folder: PlainStateFolder
    /** The Plain Folder's id on this device: what a reading place is remembered under. */
    folderId: string
}

export function createPlainPdfStateHost(deps: PlainReaderStateDeps & { memory: PdfDeviceMemory }): PdfStateHost {
    const { folder, folderId, memory } = deps
    return {
        async open(hash, target = ''): Promise<PdfStateStore> {
            const file: FileRef = { path: target, hash }
            const annotations: PdfAnnotation[] = []
            for (const item of await folder.list(PDF_ANNOTATIONS)) {
                if (!isAbout(item.value, file)) continue
                const annotation = sanitizeAnnotation((item.value as Record<string, unknown>).annotation)
                if (annotation) annotations.push(annotation)
            }
            let forms: Record<string, FormValue> = {}
            for (const item of await folder.list(PDF_FORMS)) {
                if (!isAbout(item.value, file)) continue
                const held = (item.value as Record<string, unknown>).forms
                if (isRecord(held)) forms = { ...forms, ...(held as Record<string, FormValue>) }
            }
            let state: PdfState = { annotations, forms }
            const place = memory.pdf(folderId, hash).place
            if (place) state = { ...state, place }
            const io = saving(folder, 'PDF')

            return {
                state: () => state,
                subscribe(listener) {
                    io.listeners.add(listener)
                    return () => io.listeners.delete(listener)
                },
                putAnnotation(annotation) {
                    state = { ...state, annotations: [...state.annotations.filter((held) => held.id !== annotation.id), annotation] }
                    io.changed()
                    io.save(async () => {
                        if (!isStateId(annotation.id)) throw new Error('the annotation has an id that cannot name a file')
                        await folder.put(PDF_ANNOTATIONS, annotation.id, { file, annotation })
                    })
                },
                removeAnnotation(id) {
                    state = { ...state, annotations: state.annotations.filter((held) => held.id !== id) }
                    io.changed()
                    if (isStateId(id)) io.save(() => folder.remove(PDF_ANNOTATIONS, id))
                },
                setPlace(next) {
                    state = { ...state, place: next }
                    memory.updatePdf(folderId, hash, { place: next })
                },
                setFormValue(fieldId, value) {
                    const next = { ...state.forms }
                    if (value === undefined) delete next[fieldId]
                    else next[fieldId] = value
                    state = { ...state, forms: next }
                    io.changed()
                    // One file for a PDF's form: what was typed into it is one thing to a person.
                    io.save(() => (Object.keys(next).length === 0 ? folder.remove(PDF_FORMS, hash) : folder.put(PDF_FORMS, hash, { file, forms: next })))
                },
                problem: io.problem,
                flush: async () => void (await io.settled()),
                async close() {
                    await io.settled()
                    io.listeners.clear()
                },
            }
        },
        // A PDF removed in the tree keeps its annotations: they are found again if the file returns.
        async forget(hash) {
            memory.forgetPdf(folderId, hash)
        },
    }
}

export function createPlainEbookStateHost(deps: PlainReaderStateDeps & { memory: EbookDeviceMemory }): EbookStateHost {
    const { folder, folderId, memory } = deps
    return {
        async open(hash, target = ''): Promise<EbookStateStore> {
            const file: FileRef = { path: target, hash }
            const highlights: EbookHighlight[] = []
            for (const item of await folder.list(EBOOK_HIGHLIGHTS)) {
                if (!isAbout(item.value, file)) continue
                const highlight = sanitizeEbookHighlight((item.value as Record<string, unknown>).highlight)
                if (highlight) highlights.push(highlight)
            }
            let state: EbookState = { highlights }
            const place = memory.ebook(folderId, hash).place
            if (place) state = { ...state, place }
            const io = saving(folder, 'EBook')

            return {
                state: () => state,
                subscribe(listener) {
                    io.listeners.add(listener)
                    return () => io.listeners.delete(listener)
                },
                putHighlight(highlight) {
                    state = { ...state, highlights: [...state.highlights.filter((held) => held.id !== highlight.id), highlight] }
                    io.changed()
                    io.save(async () => {
                        if (!isStateId(highlight.id)) throw new Error('the highlight has an id that cannot name a file')
                        await folder.put(EBOOK_HIGHLIGHTS, highlight.id, { file, highlight })
                    })
                },
                removeHighlight(id) {
                    state = { ...state, highlights: state.highlights.filter((held) => held.id !== id) }
                    io.changed()
                    if (isStateId(id)) io.save(() => folder.remove(EBOOK_HIGHLIGHTS, id))
                },
                setPlace(next) {
                    state = { ...state, place: next }
                    memory.updateEbook(folderId, hash, { place: next })
                },
                problem: io.problem,
                flush: async () => void (await io.settled()),
                async close() {
                    await io.settled()
                    io.listeners.clear()
                },
            }
        },
        async forget(hash) {
            memory.forgetEbook(folderId, hash)
        },
    }
}
