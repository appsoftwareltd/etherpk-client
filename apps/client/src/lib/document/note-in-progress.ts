/**
 * The [[Quick Note]] being written in the [[Quick Notes View]]: the text, the files chosen for it,
 * the [[Favourite]] it is filed under and whether it is a [[Task]], from the first key until Add.
 *
 * Held here for the open graph, and not in the View, which comes and goes: the phone's drawer
 * mounts one View at a time, a hidden View is closed, and crossing the phone's width puts up
 * another presenter. What is in the box outlives all three (ADR 0200). A reload loses it, as it
 * always has: it is not a note until it is added.
 *
 * Plain TypeScript, so it is tested in Node. A View follows it through `createSubscriber`.
 */
import { createSubscriber } from 'svelte/reactivity'

import type { AssetStore } from '#lib/storage/fs/asset-store.js'

import { NoteFileError, storeNoteFiles } from './quick-note-file-store'
import { addQuickNote } from './quick-notes'
import { shareNoteTextWithFiles } from './share-target'
import type { ImageOptimizer } from './view/image-optimize'
import { PendingNoteFiles } from './view/quick-note-pending-files'

/** Where a note's files go, read when Add is pressed: the open graph's own. */
export interface NoteStorage {
    /** The graph's [[Asset]] store, or null when it has none. */
    assets(): AssetStore | null
    /** The display size a stored picture's reference carries. */
    imageSize(): string | undefined
    /** A test's stand-in for re-encoding a picture. */
    optimize?: ImageOptimizer
}

/** What the keyboard is wanted on once the View is there to take it. */
export type QuickNotesFocus = 'box' | 'list'

interface Submitted {
    text: string
    files: File[]
    under: string | null
    asTask: boolean
}

export class NoteInProgress {
    /** Files chosen for the note, stored when it is added. */
    readonly files = new PendingNoteFiles()

    #text = ''
    #under: string | null = null
    #asTask = false
    #storing = 0
    #error = ''
    #announcement = ''
    #focus: QuickNotesFocus | null = null
    /** Raised when the graph closes, so a write that ends after it leaves the next graph's box alone. */
    #graph = 0

    readonly #listeners = new Set<() => void>()
    readonly #watch = createSubscriber((update) => this.subscribe(update))

    get text(): string {
        this.#watch()
        return this.#text
    }
    set text(text: string) {
        this.#change(() => (this.#text = text))
    }

    /** The concept the note is filed under, or none. */
    get under(): string | null {
        this.#watch()
        return this.#under
    }
    set under(under: string | null) {
        this.#change(() => (this.#under = under))
    }

    /** Whether the note is added as a [[Task]]. Off again after each add. */
    get asTask(): boolean {
        this.#watch()
        return this.#asTask
    }
    set asTask(asTask: boolean) {
        this.#change(() => (this.#asTask = asTask))
    }

    /** How many notes have files still being stored. */
    get storing(): number {
        this.#watch()
        return this.#storing
    }

    /** Why the last add did not happen, until the next one. */
    get error(): string {
        this.#watch()
        return this.#error
    }
    set error(error: string) {
        this.#change(() => (this.#error = error))
    }

    /** What the last action did, for a screen reader; what is on screen confirms itself. */
    get announcement(): string {
        this.#watch()
        return this.#announcement
    }
    set announcement(words: string) {
        this.#change(() => (this.#announcement = words))
    }

    /** What the keyboard is wanted on, asked for before the View may be there to take it. */
    get focusAsked(): QuickNotesFocus | null {
        this.#watch()
        return this.#focus
    }

    get canAdd(): boolean {
        return this.text.trim() !== '' || this.files.count > 0
    }

    /** Nothing for Clear to clear. */
    get isEmpty(): boolean {
        return this.text === '' && this.files.count === 0 && this.under === null && !this.asTask
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    askFocus(on: QuickNotesFocus): void {
        this.#change(() => (this.#focus = on))
    }

    focusTaken(): void {
        this.#change(() => (this.#focus = null))
    }

    clear(): void {
        this.files.clear()
        this.#change(() => {
            this.#empty()
            this.#error = ''
        })
    }

    /**
     * Put text into the box from outside it: a [[Share Target]] share whose write was refused
     * (ADR 0087). Text already there is kept and this goes after it, a blank line between.
     */
    offer(text: string): void {
        this.#change(() => {
            this.#text = this.#after(text)
            this.#announcement = 'The shared text is in the box'
        })
    }

    /**
     * Add the note. The box empties at once, not when the write lands: the write is asynchronous
     * (a file on a Filesystem Backend), and emptying it afterwards would wipe whatever had been
     * typed next. The note is already in the list optimistically, so the box is free. A refused
     * write gives everything back, after whatever has been typed since.
     *
     * Not guarded against an add already in flight: a second Enter while the first write is still
     * landing is a second note, not a repeat (the box was empty, so it cannot be the same text).
     * Each add is its own note with its own id, and the store tolerates the overlap.
     */
    async add(storage: NoteStorage): Promise<void> {
        if (!this.canAdd) return
        const graph = this.#graph
        const submitted: Submitted = { text: this.#text, files: this.files.take(), under: this.#under, asTask: this.#asTask }
        this.#change(() => {
            this.#empty()
            this.#error = ''
        })
        try {
            // A task's checkbox is the note's own text, as on the share page (`shareNoteText`).
            const text = submitted.files.length === 0 ? shareNoteTextWithFiles(submitted.text, [], submitted.asTask) : await this.#withFiles(submitted, storage, graph)
            // The graph closed while the files were stored: the note is not the next graph's.
            if (graph !== this.#graph) return
            const added = await addQuickNote(text, { under: submitted.under })
            if (graph === this.#graph) this.announcement = added ? 'Note added' : ''
        } catch (err) {
            if (graph === this.#graph) this.#giveBack(submitted, err)
        }
    }

    /** Graph close: the box goes with the graph it was for. */
    reset(): void {
        this.#graph += 1
        this.files.clear()
        this.#change(() => {
            this.#empty()
            this.#storing = 0
            this.#error = ''
            this.#announcement = ''
            this.#focus = null
        })
    }

    /** Store the files and write their references after the text: a photo takes a moment to re-encode. */
    async #withFiles(submitted: Submitted, storage: NoteStorage, graph: number): Promise<string> {
        const store = storage.assets()
        if (!store) throw new Error('this graph cannot store files.')
        this.#change(() => (this.#storing += 1))
        try {
            const saved = await storeNoteFiles(submitted.files, store, storage.optimize)
            return shareNoteTextWithFiles(submitted.text, saved, submitted.asTask, storage.imageSize())
        } finally {
            if (graph === this.#graph) this.#change(() => (this.#storing -= 1))
        }
    }

    #giveBack(submitted: Submitted, err: unknown): void {
        const taken = !this.isEmpty
        this.files.add(submitted.files)
        // A file already stored is named, since nothing references it.
        const stored = err instanceof NoteFileError ? err.stored.map((asset) => asset.name) : []
        const why = `Could not add the note: ${(err as Error).message}`
        this.#change(() => {
            this.#text = this.#after(submitted.text)
            // A choice made since is the person's latest.
            if (!taken) {
                this.#under = submitted.under
                this.#asTask = submitted.asTask
            }
            this.#error = stored.length > 0 ? `${why} ${stored.join(', ')} was stored and is not in any note.` : why
            this.#announcement = this.#error
        })
    }

    /** `text` after what the box holds, a blank line between; alone in an empty box. */
    #after(text: string): string {
        if (this.#text.trim() === '') return text
        return text.trim() === '' ? this.#text : `${this.#text.replace(/\s+$/, '')}\n\n${text}`
    }

    #empty(): void {
        this.#text = ''
        this.#under = null
        this.#asTask = false
    }

    #change(make: () => void): void {
        make()
        for (const listener of this.#listeners) listener()
    }
}

/** The open graph's. The workspace resets it as the graph closes. */
export const noteInProgress = new NoteInProgress()
