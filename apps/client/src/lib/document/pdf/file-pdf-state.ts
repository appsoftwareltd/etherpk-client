/**
 * A PDF's state on a [[Filesystem Backend]]: `etherpk/pdf-<hash>.json` beside `bookmarks.json`, the
 * same file a [[Local Mirror]] and an [[Export]] carry for a synced graph. One browser owns the
 * folder, so there is no concurrent peer and the whole file is written each time.
 *
 * The [[Reading Place]] stays out of the file and on the device, because a write per reading
 * session would dirty a folder tracked in git (`device-memory.ts`).
 *
 * A file that is there but cannot be read is never written over: every write is then refused with
 * the reason, as `bookmarks-file.ts` refuses, because the next write would replace what the person
 * made with an empty list.
 */
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'

import type { PdfDeviceMemory, ReadingPlace } from './device-memory'
import { emptyPdfState, sanitizePdfState, type PdfState, type PdfStateHost, type PdfStateStore } from './pdf-state'

/** The state file of a PDF, under `etherpk/`. */
export const pdfStateFileName = (hash: string): string => `pdf-${hash}.json`

/** A name {@link pdfStateFileName} wrote: its hash, or `null`. */
export function pdfHashFromStateFile(name: string): string | null {
    return /^pdf-([0-9a-f]{64})\.json$/.exec(name)?.[1] ?? null
}

/** The file's text: pretty-printed and newline-terminated, the mirror's shape too. */
export function pdfStateFileText(state: Pick<PdfState, 'annotations' | 'forms'>): string {
    const { annotations, forms } = state
    return `${JSON.stringify({ version: 1, annotations, forms }, null, 2)}\n`
}

/** Merge imported state into what a file holds, by id: importing the same export twice adds nothing. */
export function mergePdfState(held: PdfState, incoming: PdfState): PdfState {
    const heldAnnotations = new Set(held.annotations.map((a) => a.id))
    return {
        ...held,
        annotations: [...held.annotations, ...incoming.annotations.filter((a) => !heldAnnotations.has(a.id))],
        forms: { ...incoming.forms, ...held.forms },
    }
}

/** Write imported state into a folder graph's file, keeping what it holds. */
export async function importPdfStateFile(adapter: DirectoryAdapter, hash: string, incoming: PdfState): Promise<void> {
    const name = pdfStateFileName(hash)
    const held = (await adapter.exists('etherpk', name)) ? sanitizePdfState(JSON.parse((await adapter.read('etherpk', name)).text)) : emptyPdfState()
    await adapter.write('etherpk', name, pdfStateFileText(mergePdfState(held, incoming)))
}

/** Each imported PDF's state, merged by id, so importing the same export twice adds nothing. */
export async function importPdfStateFiles(adapter: DirectoryAdapter, states: readonly { hash: string; state: PdfState }[] = []): Promise<void> {
    for (const { hash, state } of states) await importPdfStateFile(adapter, hash, state)
}

const WRITE_DELAY_MS = 300

export interface FilePdfStateDeps {
    adapter: DirectoryAdapter
    memory: PdfDeviceMemory
    graphId: string
}

async function openFileState(deps: FilePdfStateDeps, hash: string): Promise<PdfStateStore> {
    const { adapter, memory, graphId } = deps
    const name = pdfStateFileName(hash)
    let state = emptyPdfState()
    let refused: string | null = null
    try {
        if (await adapter.exists('etherpk', name)) {
            const { text } = await adapter.read('etherpk', name)
            const parsed: unknown = JSON.parse(text)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a PDF state file')
            state = sanitizePdfState(parsed)
        }
    } catch (error) {
        refused = `etherpk/${name} could not be read (${error instanceof Error ? error.message : String(error)}), so changes to this PDF are not being saved. Fix or remove the file, then open the PDF again.`
    }
    const remembered = memory.pdf(graphId, hash).place
    if (remembered) state = { ...state, place: remembered }

    const listeners = new Set<() => void>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let dirty = false
    let writes: Promise<unknown> = Promise.resolve()

    const changed = () => {
        for (const listener of listeners) listener()
    }

    function write(): Promise<unknown> {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (!dirty || refused) return writes
        dirty = false
        const text = pdfStateFileText(state)
        // Writes run one at a time, so an older one can never land after a newer one.
        writes = writes.then(async () => {
            try {
                await adapter.write('etherpk', name, text)
            } catch (error) {
                refused = `Changes to this PDF could not be saved to etherpk/${name} (${error instanceof Error ? error.message : String(error)}).`
                changed()
            }
        })
        return writes
    }

    function schedule(next: PdfState): void {
        state = next
        changed()
        if (refused) return
        dirty = true
        if (timer === undefined) timer = setTimeout(() => void write(), WRITE_DELAY_MS)
    }

    return {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        putAnnotation(annotation) {
            schedule({ ...state, annotations: [...state.annotations.filter((a) => a.id !== annotation.id), annotation] })
        },
        removeAnnotation(id) {
            schedule({ ...state, annotations: state.annotations.filter((a) => a.id !== id) })
        },
        setPlace(place: ReadingPlace) {
            state = { ...state, place }
            memory.updatePdf(graphId, hash, { place })
        },
        setFormValue(fieldId, value) {
            const forms = { ...state.forms }
            if (value === undefined) delete forms[fieldId]
            else forms[fieldId] = value
            schedule({ ...state, forms })
        },
        problem: () => refused,
        async flush() {
            await write()
        },
        async close() {
            await write()
            listeners.clear()
        },
    }
}

export function createFilePdfStateHost(deps: FilePdfStateDeps): PdfStateHost {
    return {
        open: (hash) => openFileState(deps, hash),
        async forget(hash) {
            const name = pdfStateFileName(hash)
            if (await deps.adapter.exists('etherpk', name)) await deps.adapter.remove('etherpk', name)
            deps.memory.forgetPdf(deps.graphId, hash)
        },
    }
}
