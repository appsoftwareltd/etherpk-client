/**
 * A PDF's state on a [[Server Backend]]: a private Y.Doc per person per PDF, sealed under the
 * [[Graph Key]] like any document, with no entry in the registry. So it appears in no list, Search
 * and the index never read it, the [[Headless Client]] never opens it, and it loads only when its PDF
 * opens. Writes do not reach other Members' open Clients, as a write to the root document would on
 * every page turn.
 *
 * Annotations and form values are Y.Map entries by id, so two of a person's devices that
 * annotate while apart merge entry by entry. The [[Reading Place]] is one entry, and the later write
 * stays. Each entry's value is plain JSON, replaced whole: an annotation is edited by one person.
 */
import * as Y from 'yjs'

import {
    emptyPdfState,
    sanitizeAnnotation,
    sanitizePlace,
    type FormValue,
    type PdfAnnotation,
    type PdfState,
    type PdfStateStore,
} from './pdf-state'
import type { ReadingPlace } from './device-memory'

const ANNOTATIONS = 'annotations'
const FORMS = 'forms'
const PLACE = 'place'

/** Read a private document's state. Exported for the [[Local Mirror]] and an [[Export]]. */
export function readPdfStateDoc(doc: Y.Doc): PdfState {
    const annotations: PdfAnnotation[] = []
    doc.getMap<unknown>(ANNOTATIONS).forEach((value) => {
        const clean = sanitizeAnnotation(value)
        if (clean) annotations.push(clean)
    })
    const forms: Record<string, FormValue> = {}
    doc.getMap<unknown>(FORMS).forEach((value, key) => {
        if (typeof value === 'object' && value !== null) forms[key] = value as FormValue
    })
    const place = sanitizePlace(doc.getMap<unknown>(PLACE).get(PLACE))
    return { ...emptyPdfState(), annotations, forms, ...(place ? { place } : {}) }
}

/** Put a whole state into a private document: the Import path. Entries merge by id. */
export function writePdfStateDoc(doc: Y.Doc, state: Pick<PdfState, 'annotations' | 'forms'>): void {
    doc.transact(() => {
        const annotations = doc.getMap<unknown>(ANNOTATIONS)
        for (const annotation of state.annotations) annotations.set(annotation.id, annotation)
        const forms = doc.getMap<unknown>(FORMS)
        for (const [key, value] of Object.entries(state.forms)) forms.set(key, value)
    })
}

export interface SyncedPdfStateDeps {
    doc: Y.Doc
    /** Resolves once what this device holds has been read. Never waits for the network. */
    ready(): Promise<void>
    flush(): Promise<void>
    /** Let go of the document, once nothing is left to send. */
    release(): void
    /** Something worth carrying in an Export was written. Absent where nothing keeps a list. */
    noteContent?(): void
}

export async function openSyncedPdfState(deps: SyncedPdfStateDeps): Promise<PdfStateStore> {
    const { doc } = deps
    await deps.ready()
    const listeners = new Set<() => void>()
    let state = readPdfStateDoc(doc)
    const onUpdate = () => {
        state = readPdfStateDoc(doc)
        for (const listener of listeners) listener()
    }
    doc.on('update', onUpdate)
    return {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        putAnnotation(annotation) {
            deps.noteContent?.()
            doc.getMap(ANNOTATIONS).set(annotation.id, annotation)
        },
        removeAnnotation: (id) => void doc.getMap(ANNOTATIONS).delete(id),
        setPlace: (place: ReadingPlace) => void doc.getMap(PLACE).set(PLACE, place),
        setFormValue(fieldId, value) {
            deps.noteContent?.()
            if (value === undefined) doc.getMap(FORMS).delete(fieldId)
            else doc.getMap(FORMS).set(fieldId, value)
        },
        problem: () => null,
        flush: () => deps.flush(),
        async close() {
            doc.off('update', onUpdate)
            listeners.clear()
            await deps.flush().catch(() => {})
            deps.release()
        },
    }
}

/** The store of a synced graph opened with no member key, which has no person to keep it for. */
export function refusingPdfState(reason: string): PdfStateStore {
    const state = emptyPdfState()
    return {
        state: () => state,
        subscribe: () => () => {},
        putAnnotation: () => {},
        removeAnnotation: () => {},
        setPlace: () => {},
        setFormValue: () => {},
        problem: () => reason,
        flush: async () => {},
        close: async () => {},
    }
}
