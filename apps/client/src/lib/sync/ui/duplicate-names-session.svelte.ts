/**
 * The open graph's [[Duplicate Name]] review (ADR 0157): the names that belong to more than one
 * document, their texts as the Maintenance section shows them, and each Merge, as reactive state.
 *
 * The workspace owns one per open Server-backed graph, so a dismissed dialog and a chosen order
 * survive closing Settings and go when the graph closes. The list follows the registry live. The
 * texts are read only while the section is open, and only for the documents of a pair.
 *
 * The rules are one layer down, in `duplicate-names.ts`, `duplicate-names-copy.ts` and the
 * store's `mergeDuplicates`. This is plumbing.
 */

import { documentProtection } from '$lib/document/protection/cipher-fence'
import { type DuplicateName, findDuplicateNames, longestFirst, mergedText, textSummary } from '$lib/storage/server/duplicate-names'
import type { ServerDocumentStore } from '$lib/storage/server/server-document-store'
import { mergeOutcomeMessage } from './duplicate-names-copy'

export type DuplicateNamesSource = Pick<ServerDocumentStore, 'listIdentities' | 'onDocumentsChanged' | 'readTexts' | 'mergeDuplicates'>

export interface DuplicateDocumentRow {
    docId: string
    lines: number
    firstLine: string
    isProtected: boolean
}

export interface DuplicateNameRow {
    key: string
    concept: string
    kind: DuplicateName['kind']
    /** `reading` until every document's text is here, `unreadable` if one could not be. */
    state: 'reading' | 'unreadable' | 'ready'
    /** In Merge order: the first is the document that is kept. */
    documents: DuplicateDocumentRow[]
    hasProtected: boolean
    /** What the first document will hold after the Merge, for the preview. */
    merged: string
    confirming: boolean
    merging: boolean
    previewing: boolean
    /** What the last Merge of this name said, when it did not finish. */
    message: string | null
}

interface RowUi {
    order?: string[]
    confirming?: boolean
    merging?: boolean
    previewing?: boolean
    message?: string | null
}

const keyOf = (name: DuplicateName) => name.documents.map((d) => d.docId).sort().join(' ')

export class DuplicateNamesSession {
    names = $state.raw<DuplicateName[]>([])
    /** What the person last merged, for the section's live region. */
    lastMerged = $state<string | null>(null)
    /** Not now, or Review: the dialog at open is not offered again until the graph is opened again. */
    noticeDismissed = $state(false)
    /** Set by the dialog's Review: the section scrolls itself into view once, then clears it. */
    revealRequested = $state(false)

    #texts = $state.raw(new Map<string, string>())
    #unreadable = $state.raw(new Set<string>())
    #ui = $state.raw<Record<string, RowUi>>({})
    #reading = new Set<string>()
    /** Open sections reading texts: the list alone needs none. */
    #readers = 0
    #source: DuplicateNamesSource
    #stop: () => void
    #disposed = false

    constructor(source: DuplicateNamesSource) {
        this.#source = source
        this.#stop = source.onDocumentsChanged(() => this.refresh())
    }

    rows = $derived.by((): DuplicateNameRow[] =>
        this.names.map((name) => {
            const key = keyOf(name)
            const ui = this.#ui[key] ?? {}
            const ids = name.documents.map((d) => d.docId)
            const texts = this.#texts
            const ready = ids.every((id) => texts.has(id))
            const state = ids.some((id) => this.#unreadable.has(id)) ? 'unreadable' : ready ? 'ready' : 'reading'
            const order = ui.order && ui.order.length === ids.length && ui.order.every((id) => ids.includes(id))
                ? ui.order
                : ready ? longestFirst(ids, texts) : ids
            const documents = order.map((docId) => {
                const text = texts.get(docId) ?? ''
                return { docId, ...textSummary(text), isProtected: documentProtection(text).kind === 'document' }
            })
            return {
                key,
                concept: name.concept,
                kind: name.kind,
                state,
                documents,
                hasProtected: documents.some((d) => d.isProtected),
                merged: state === 'ready' ? mergedText(order.map((id) => texts.get(id) ?? '')) : '',
                confirming: ui.confirming ?? false,
                merging: ui.merging ?? false,
                previewing: ui.previewing ?? false,
                message: ui.message ?? null,
            }
        }),
    )

    /** Read the registry again. Cheap: no text is read unless a section is open. */
    refresh(): void {
        if (this.#disposed) return
        this.names = findDuplicateNames(this.#source.listIdentities())
        if (this.#readers > 0) void this.#readMissing()
    }

    /** A section opened: read the texts of every pair. Returns the close. */
    open(): () => void {
        this.#readers += 1
        this.refresh()
        let closed = false
        return () => {
            if (closed) return
            closed = true
            this.#readers -= 1
        }
    }

    /** Read a name's texts again, after they could not be read. */
    retry(key: string): void {
        const name = this.#name(key)
        if (!name) return
        this.#forget(name.documents.map((d) => d.docId))
        void this.#readMissing()
    }

    makeFirst(key: string, docId: string): void {
        const row = this.rows.find((r) => r.key === key)
        if (!row || row.merging) return
        const order = [docId, ...row.documents.map((d) => d.docId).filter((id) => id !== docId)]
        this.#patch(key, { order, confirming: false })
    }

    togglePreview(key: string): void {
        this.#patch(key, { previewing: !(this.#ui[key]?.previewing ?? false) })
    }

    askMerge(key: string): void {
        this.#patch(key, { confirming: true, message: null })
    }

    cancelMerge(key: string): void {
        this.#patch(key, { confirming: false })
    }

    async merge(key: string): Promise<void> {
        const row = this.rows.find((r) => r.key === key)
        // Guarded here as well as on the button: a second press must not start a second Merge.
        if (!row || row.merging || row.state !== 'ready' || row.hasProtected) return
        const order = row.documents.map((d) => d.docId)
        const expected = new Map(order.map((id) => [id, this.#texts.get(id) ?? '']))
        this.#patch(key, { merging: true, confirming: false, message: null })
        try {
            const outcome = await this.#source.mergeDuplicates(order, expected)
            if (this.#disposed) return
            if (outcome === 'merged') {
                this.lastMerged = row.concept
                this.#patch(key, { merging: false })
                this.refresh()
                return
            }
            this.#patch(key, { merging: false, message: mergeOutcomeMessage(outcome) })
            // What was shown is no longer what is there: read it again, so the next Merge is
            // confirmed against the texts as they are now.
            if (outcome !== 'offline' && outcome !== 'protected') {
                this.#forget(order)
                this.refresh()
            }
        } catch (error) {
            if (this.#disposed) return
            this.#patch(key, { merging: false, message: `The merge stopped: ${error instanceof Error ? error.message : String(error)}` })
        }
    }

    /** The dialog's Review asked for the section: it scrolls into view and says so once. */
    requestReveal(): void {
        this.revealRequested = true
    }

    dispose(): void {
        this.#disposed = true
        this.#stop()
    }

    #name(key: string): DuplicateName | undefined {
        return this.names.find((name) => keyOf(name) === key)
    }

    #patch(key: string, change: RowUi): void {
        this.#ui = { ...this.#ui, [key]: { ...this.#ui[key], ...change } }
    }

    #forget(docIds: readonly string[]): void {
        const texts = new Map(this.#texts)
        const unreadable = new Set(this.#unreadable)
        for (const id of docIds) {
            texts.delete(id)
            unreadable.delete(id)
        }
        this.#texts = texts
        this.#unreadable = unreadable
    }

    async #readMissing(): Promise<void> {
        const wanted = this.names
            .flatMap((name) => name.documents.map((d) => d.docId))
            .filter((id) => !this.#texts.has(id) && !this.#unreadable.has(id) && !this.#reading.has(id))
        if (wanted.length === 0) return
        for (const id of wanted) this.#reading.add(id)
        try {
            const read = await this.#source.readTexts(wanted)
            if (this.#disposed) return
            const texts = new Map(this.#texts)
            const unreadable = new Set(this.#unreadable)
            for (const id of wanted) {
                const result = read.get(id)
                // An empty document reads as unsettled too (a cache miss looks the same), and an
                // empty document is a real thing to merge, so only a text that is missing or
                // blocked counts as unreadable.
                if (result && (result.settled || result.text === '')) texts.set(id, result.text)
                else unreadable.add(id)
            }
            this.#texts = texts
            this.#unreadable = unreadable
        } catch {
            if (this.#disposed) return
            const unreadable = new Set(this.#unreadable)
            for (const id of wanted) unreadable.add(id)
            this.#unreadable = unreadable
        } finally {
            for (const id of wanted) this.#reading.delete(id)
        }
    }
}
