/**
 * An EBook's state on a [[Server Backend]]: a private Y.Doc per person per EBook, sealed under the
 * [[Graph Key]], with no entry in the registry, exactly as a PDF's is (ADR 0176). Highlights are Y.Map
 * entries by id, so two of a person's devices that mark an EBook while apart merge entry by entry. The
 * [[Reading Place]] is one entry, and the later write stays.
 */
import * as Y from 'yjs'

import { sanitizeEbookHighlight, sanitizeEbookPlace, type EbookHighlight, type EbookPlace, type EbookState, type EbookStateStore } from './ebook-state'

const HIGHLIGHTS = 'highlights'
const PLACE = 'place'

/** Read a private document's state. Exported for the [[Local Mirror]] and an [[Export]]. */
export function readEbookStateDoc(doc: Y.Doc): EbookState {
    const highlights: EbookHighlight[] = []
    doc.getMap<unknown>(HIGHLIGHTS).forEach((value) => {
        const clean = sanitizeEbookHighlight(value)
        if (clean) highlights.push(clean)
    })
    const place = sanitizeEbookPlace(doc.getMap<unknown>(PLACE).get(PLACE))
    return { highlights, ...(place ? { place } : {}) }
}

/** Put a whole state into a private document: the Import path. Entries merge by id. */
export function writeEbookStateDoc(doc: Y.Doc, state: Pick<EbookState, 'highlights'>): void {
    doc.transact(() => {
        const highlights = doc.getMap<unknown>(HIGHLIGHTS)
        for (const highlight of state.highlights) highlights.set(highlight.id, highlight)
    })
}

export interface SyncedEbookStateDeps {
    doc: Y.Doc
    /** Resolves once what this device holds has been read. Never waits for the network. */
    ready(): Promise<void>
    flush(): Promise<void>
    /** Let go of the document, once nothing is left to send. */
    release(): void
    /** Something worth carrying in an Export was written. Absent where nothing keeps a list. */
    noteContent?(): void
}

export async function openSyncedEbookState(deps: SyncedEbookStateDeps): Promise<EbookStateStore> {
    const { doc } = deps
    await deps.ready()
    const listeners = new Set<() => void>()
    let state = readEbookStateDoc(doc)
    const onUpdate = () => {
        state = readEbookStateDoc(doc)
        for (const listener of listeners) listener()
    }
    doc.on('update', onUpdate)
    return {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        putHighlight(highlight) {
            deps.noteContent?.()
            doc.getMap(HIGHLIGHTS).set(highlight.id, highlight)
        },
        removeHighlight: (id) => void doc.getMap(HIGHLIGHTS).delete(id),
        setPlace: (place: EbookPlace) => void doc.getMap(PLACE).set(PLACE, place),
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
