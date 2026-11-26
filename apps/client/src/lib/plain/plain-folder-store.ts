/**
 * The document store of a [[Plain Folder]]: text files opened by their path and saved where they
 * are, with nothing else written (ADR 0194, ADR 0196).
 *
 * It is not a graph's store. There is no scan, no registry of names and no index: a file is opened
 * when a tab asks for it and forgotten when the workspace closes. What it does have, the Folder
 * graph store has too, and for the same reasons (filesystem-store.ts): one write at a time per
 * file, a save that never rejects, a buffer that outlives a failed write, and a rescan that never
 * judges a file while our own write to it is landing.
 *
 * Where it differs:
 *
 * - **A save changes only the edited lines.** The file is read as bytes, and its byte order mark
 *   and line endings are kept (file-form.ts). A save with no change writes nothing.
 * - **A save reads the file first.** When another program has changed it, the save stops at a
 *   conflict. The File System Access API has no compare-and-set, so in a browser a write landing
 *   between that read and ours is still replaced (spec/folder-save, `bugs/Window.cfg`). An installed
 *   app's shell refuses that write (write-unless-moved.ts).
 * - **A file that is gone is never written back unasked.** A Folder graph brings it back, since an
 *   edit outranks a delete there (ADR 0039). Here a checkout or another editor removed it on
 *   purpose, so the tab says so and `restore` is the person's to press.
 * - **A file it cannot edit safely opens read-only:** one that is not UTF-8, or is larger than the
 *   editing limit.
 */
import { DocumentNotFoundError, type DocumentStore, type EditorDocument, type TextChange } from '../document/types'
import { lineFeedsOnly } from '../document/line-endings'
import { type Debounced, debounce } from '../storage/fs/debounce'
import { expectedOf, untilWritten, writeUnlessMoved } from '../storage/fs/write-unless-moved'

import { type FileForm, decodeFile, encodeFile, placeEdits } from './file-form'
import { type FileBytes, type FileStamp, type FolderTreeAdapter, isNotFound } from './folder-tree-adapter'
import { dirOf, normalisePath } from './plain-path'

/** Above this size a file opens read-only until the person chooses to edit it anyway (ADR 0196). */
export const EDIT_LIMIT_BYTES = 2 * 1024 * 1024

/** Why a file cannot be edited as it stands. */
export type ReadOnlyReason = 'not-utf8' | 'too-large'

/** The file and the buffer disagree, and only the person can say which is kept. */
export interface PlainConflict {
    path: string
    /** The file's text as it is now, with line feeds only, for showing beside the buffer. */
    diskText: string
    bufferText: string
}

/** What a tab needs to know about its file, beyond the text. */
export interface PlainFileState {
    path: string
    /** The buffer reflects the file. False while the first read is in flight, or after it failed. */
    loaded: boolean
    /** Nothing was at the path when it was opened. */
    missing: boolean
    /** The file was open and has since been removed by something else. */
    removedElsewhere: boolean
    readOnly: ReadOnlyReason | null
    /** The file's size in bytes when last read: what a too-large notice names. */
    size: number
    dirty: boolean
    conflict: PlainConflict | null
    /** Why the last read or write failed, until one succeeds. */
    error: unknown
}

export interface PlainFolderStoreOptions {
    /** How long after the last edit a save starts. */
    autosaveMs?: number
    editLimitBytes?: number
    onConflict?: (conflict: PlainConflict) => void
    /** A read or write failed. The buffer keeps the text; a flush or the next edit tries again. */
    onSaveError?: (path: string, error: unknown) => void
}

export interface PlainFolderStore extends DocumentStore {
    whenReady(path: string): Promise<void>
    /** The path as the folder spells it, or null when nothing is there. Ask before opening a path that was typed or linked. */
    canonicalPath(path: string): Promise<string | null>
    stateOf(path: string): PlainFileState | null
    /** Told the path of a file whose state changed (loaded, saved, removed, conflict and so on). */
    onStateChanged(listener: (path: string) => void): () => void
    /** Told when an open file takes a new path: a move in the tree, or the folder's own spelling of a name. */
    onDocumentRenamed(listener: (from: string, to: string) => void): () => void
    /** Write the buffer now if it is unsaved, and wait for every write in flight. */
    flushDocument(path: string): Promise<void>
    flushAll(): Promise<void>
    /** The paths of the open files whose edits are not in the folder. After a flush, those that could not be written. */
    unsavedPaths(): string[]
    /** Compare every open file with the folder: reload, raise a conflict, or note a removal. */
    reconcile(): Promise<void>
    resolveConflict(path: string, choice: 'keep-mine' | 'take-disk'): Promise<void>
    /** Write the buffer back as a file removed elsewhere, or create the file a missing path names. */
    restore(path: string): Promise<void>
    /** Edit a file over the size limit after all. */
    editAnyway(path: string): void
    /** Save and settle everything open at or under `path`, before the tree moves or removes it. */
    settleUnder(path: string): Promise<void>
    /** The tree moved `from` to `to`: open files follow. */
    moved(from: string, to: string): void
    /** The person removed `path` in the tree: open files there are dropped, their edits with them. */
    removed(path: string): void
    /** The paths of the files open now. */
    openPaths(): string[]
    dispose(): Promise<void>
}

interface OpenFile {
    path: string
    buffer: string
    /** The file's text as last read or written, with its own line endings. */
    diskText: string
    form: FileForm
    lastModified: number
    size: number
    loaded: boolean
    missing: boolean
    removedElsewhere: boolean
    readOnly: ReadOnlyReason | null
    dirty: boolean
    conflict: PlainConflict | null
    error: unknown
    ready: Promise<void>
    listeners: Set<(text: string) => void>
    save: Debounced<[]>
    /** The write in flight, if any. Never rejects. */
    saving: Promise<void> | null
    /** A write was wanted while one was in flight. */
    queued: boolean
    /** Dropped by a removal in the tree: nothing more is read or written for it. */
    closed: boolean
    handle: EditorDocument
}

/** A file's text and form as read, or the reason it cannot be edited. */
type Read =
    | { kind: 'text'; text: string; form: FileForm; stamp: FileStamp }
    | { kind: 'not-utf8'; text: string; stamp: FileStamp }
    | { kind: 'too-large'; stamp: FileStamp }

function applyTextChange(text: string, change: TextChange): string {
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

const isUnder = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`)

export function createPlainFolderStore(adapter: FolderTreeAdapter, options: PlainFolderStoreOptions = {}): PlainFolderStore {
    const { autosaveMs = 400, editLimitBytes = EDIT_LIMIT_BYTES, onConflict, onSaveError } = options
    const open = new Map<string, OpenFile>()
    /** Files the person chose to edit although they are over the limit. */
    const limitWaived = new Set<string>()
    const stateListeners = new Set<(path: string) => void>()
    const renameListeners = new Set<(from: string, to: string) => void>()

    const changed = (doc: OpenFile) => {
        for (const listener of stateListeners) listener(doc.path)
    }
    const notify = (doc: OpenFile, except?: (text: string) => void) => {
        for (const listener of doc.listeners) if (listener !== except) listener(doc.buffer)
    }

    function interpret(path: string, file: FileBytes): Read {
        const stamp = { lastModified: file.lastModified, size: file.size }
        if (file.size > editLimitBytes && !limitWaived.has(path)) return { kind: 'too-large', stamp }
        const decoded = decodeFile(file.bytes)
        if (decoded.ok) return { kind: 'text', text: decoded.text, form: decoded.form, stamp }
        // Shown, never saved: the lossy text is for reading only.
        return { kind: 'not-utf8', text: new TextDecoder().decode(file.bytes), stamp }
    }

    /** Take the file as read for the buffer's whole truth: at open, on reload and on take-disk. */
    function adopt(doc: OpenFile, read: Read): void {
        doc.lastModified = read.stamp.lastModified
        doc.size = read.stamp.size
        doc.loaded = true
        doc.missing = false
        doc.removedElsewhere = false
        doc.error = null
        doc.dirty = false
        doc.conflict = null
        if (read.kind === 'text') {
            doc.readOnly = null
            doc.diskText = read.text
            doc.form = read.form
            // The editor's buffer holds line feeds only; the file's own endings stay in `diskText`.
            doc.buffer = lineFeedsOnly(read.text)
        } else {
            doc.readOnly = read.kind
            doc.diskText = ''
            doc.buffer = read.kind === 'not-utf8' ? lineFeedsOnly(read.text) : ''
        }
    }

    /** The text to write for the buffer: its lines placed into the file as last read. */
    const toWrite = (doc: OpenFile, buffer: string) => placeEdits(doc.diskText, buffer, doc.form)

    /** Whether the file as just read is what the buffer last agreed with. */
    const sameAsRead = (doc: OpenFile, read: Read) => read.kind === 'text' && read.text === doc.diskText && read.form.bom === doc.form.bom

    function raiseConflict(doc: OpenFile, diskText: string): void {
        doc.conflict = { path: doc.path, diskText: lineFeedsOnly(diskText), bufferText: doc.buffer }
        doc.save.cancel()
        onConflict?.(doc.conflict)
    }

    /**
     * Bring an open file in line with the folder's copy as just read: nothing when it is what the
     * buffer last agreed with, a reload of a buffer with no unsaved edits, a conflict over one with.
     */
    function followDisk(doc: OpenFile, read: Read): void {
        if (sameAsRead(doc, read) && doc.loaded) {
            doc.lastModified = read.stamp.lastModified
            doc.size = read.stamp.size
            if (doc.removedElsewhere) {
                // The file is back exactly as the buffer last agreed with it: carry on saving.
                doc.removedElsewhere = false
                if (doc.dirty) doc.save.call()
                changed(doc)
            }
            return
        }
        if (doc.dirty) raiseConflict(doc, read.kind === 'too-large' ? '' : read.text)
        else {
            adopt(doc, read)
            notify(doc)
        }
        changed(doc)
    }

    function noteRemoved(doc: OpenFile): void {
        if (doc.removedElsewhere || doc.missing) return
        doc.removedElsewhere = true
        doc.save.cancel()
        changed(doc)
    }

    /**
     * Write the buffer's text, after reading the file to see that it is still what the buffer last
     * agreed with. Resolves true once the file holds it, false when the save stopped: the file had
     * moved or gone.
     */
    function writeChecked(doc: OpenFile, written: string): Promise<boolean> {
        return untilWritten(async () => {
            const file = await readNow(doc)
            if (file === null) {
                noteRemoved(doc)
                return false
            }
            const read = interpret(doc.path, file)
            if (!sameAsRead(doc, read)) return alreadyWritten(doc, read, written)
            // Nothing between the read above and this write: in a browser that moment is the one a
            // write from outside can still slip into.
            const stamp = await writeOver(doc, read.stamp, written)
            // Null is a write refused because the file moved since the read: read and judge it again.
            return stamp === null ? undefined : holdsNow(doc, written, stamp)
        })
    }

    /** The file is not what the buffer last agreed with. True when another program made the same edit. */
    function alreadyWritten(doc: OpenFile, read: Read, written: string): boolean {
        if (read.kind === 'text' && read.text === written && read.form.bom === doc.form.bom) return holdsNow(doc, written, read.stamp)
        followDisk(doc, read)
        return false
    }

    /** The file holds `written`, with these stamps. */
    function holdsNow(doc: OpenFile, written: string, stamp: FileStamp): true {
        doc.diskText = written
        doc.lastModified = stamp.lastModified
        doc.size = stamp.size
        return true
    }

    /** Write over the file as it was just read, or where there was none. Null when it has moved since. */
    function writeOver(doc: OpenFile, read: FileStamp | null, text: string): Promise<FileStamp | null> {
        return writeUnlessMoved(
            expectedOf(read),
            (expected) => adapter.write(doc.path, encodeFile(text, doc.form), expected),
            async () => {
                const stat = await adapter.stat(doc.path)
                return stat?.kind === 'file' ? stat : null
            },
        )
    }

    /** A file whose buffer may be written: read, editable, there, and not waiting on the person. */
    const savable = (doc: OpenFile) => doc.loaded && !doc.closed && !doc.conflict && !doc.removedElsewhere && !doc.missing && doc.readOnly === null

    /** Start the file's save if none is in flight, else note that one is wanted. */
    function runSave(doc: OpenFile): void {
        if (!savable(doc)) {
            doc.queued = false
            // Edits to a file that could not be read are not reaching the folder: say so.
            if (!doc.loaded && doc.error !== null && !doc.closed) onSaveError?.(doc.path, doc.error)
            return
        }
        if (doc.saving) {
            doc.queued = true
            return
        }
        doc.queued = false
        const snapshot = doc.buffer
        const written = toWrite(doc, snapshot)
        if (written === doc.diskText) {
            // Nothing a save would change (typed and taken back, say): no write, and no read.
            doc.dirty = doc.buffer !== snapshot
            changed(doc)
            return
        }
        doc.saving = writeChecked(doc, written)
            .then(
                (saved) => {
                    if (!saved) return
                    doc.error = null
                    doc.dirty = doc.buffer !== snapshot
                },
                (error: unknown) => {
                    doc.error = error
                    if (!doc.closed) onSaveError?.(doc.path, error)
                },
            )
            .finally(() => {
                doc.saving = null
                changed(doc)
                if (doc.queued && doc.dirty) runSave(doc)
            })
    }

    async function settled(doc: OpenFile): Promise<void> {
        while (doc.saving) await doc.saving
    }

    async function saveNow(doc: OpenFile): Promise<void> {
        doc.save.cancel()
        await doc.ready
        if (doc.dirty) runSave(doc)
        await settled(doc)
    }

    /** Read the file into a file just opened. */
    async function hydrate(doc: OpenFile): Promise<void> {
        try {
            const file = await adapter.read(doc.path)
            // The buffer may have been typed into while the read was in flight. Those edits were
            // made against nothing, so the file wins and the editor is told.
            adopt(doc, interpret(doc.path, file))
            notify(doc)
        } catch (error) {
            if (isNotFound(error)) doc.missing = true
            else doc.error = error
        }
        changed(doc)
    }

    function makeOpenFile(path: string): OpenFile {
        const doc: OpenFile = {
            path,
            buffer: '',
            diskText: '',
            form: { bom: false, eol: '\n' },
            lastModified: 0,
            size: 0,
            loaded: false,
            missing: false,
            removedElsewhere: false,
            readOnly: null,
            dirty: false,
            conflict: null,
            error: null,
            ready: Promise.resolve(),
            listeners: new Set(),
            save: undefined as unknown as Debounced<[]>,
            saving: null,
            queued: false,
            closed: false,
            handle: undefined as unknown as EditorDocument,
        }
        doc.save = debounce(() => runSave(doc), autosaveMs)
        doc.handle = {
            // Live: the file can take a new path while it is open (`moved`).
            get id() {
                return doc.path
            },
            getText: () => doc.buffer,
            applyChange(change, origin = 'editor', editor) {
                // A file that cannot be edited keeps its text whatever asks: the editor is drawn
                // read-only for it, and this is the last line behind that.
                if (doc.readOnly !== null || doc.closed) return
                doc.buffer = applyTextChange(doc.buffer, change)
                doc.dirty = true
                doc.save.call()
                if (origin === 'external') notify(doc)
                else if (editor) notify(doc, editor)
                changed(doc)
            },
            subscribe(listener) {
                doc.listeners.add(listener)
                return () => doc.listeners.delete(listener)
            },
        }
        doc.ready = hydrate(doc)
        return doc
    }

    function fileAt(path: string): OpenFile | undefined {
        const normal = normalisePath(path)
        return normal === null ? undefined : open.get(normal)
    }

    async function reconcileFile(doc: OpenFile): Promise<void> {
        await doc.ready
        // Never judge a file while our own write to it is landing.
        await settled(doc)
        if (doc.closed || doc.conflict) return
        const stat = await adapter.stat(doc.path)
        if (stat === null || stat.kind !== 'file') {
            if (doc.loaded) noteRemoved(doc)
            return
        }
        if (asLastSeen(doc, stat)) return
        const read = interpret(doc.path, await adapter.read(doc.path))
        if (doc.missing) appeared(doc, read)
        else followDisk(doc, read)
    }

    /** The file is there with the stamps the store last saw, so there is nothing to read. */
    function asLastSeen(doc: OpenFile, stat: FileStamp): boolean {
        const cameBack = doc.missing || doc.removedElsewhere
        return !cameBack && doc.loaded && stat.lastModified === doc.lastModified && stat.size === doc.size
    }

    /** What a conflict dialog would show for the file as read now, or null when the file has gone. */
    function shownOf(read: Read | null): string | null {
        if (read === null) return null
        return read.kind === 'too-large' ? '' : lineFeedsOnly(read.text)
    }

    /** A file now exists where there was none. Nothing typed: take it. Otherwise ask. */
    function appeared(doc: OpenFile, read: Read): void {
        if (doc.dirty) raiseConflict(doc, read.kind === 'too-large' ? '' : read.text)
        else {
            adopt(doc, read)
            notify(doc)
        }
        changed(doc)
    }

    /** The file as it is now, or null when it has gone. */
    async function readNow(doc: OpenFile): Promise<FileBytes | null> {
        try {
            return await adapter.read(doc.path)
        } catch (error) {
            if (!isNotFound(error)) throw error
            return null
        }
    }

    /** Throws, with the newer version shown, when the file is neither what the person was shown nor what would be written. */
    function askAgainIfMoved(doc: OpenFile, shown: PlainConflict, read: Read | null): void {
        const shownNow = shownOf(read)
        if (shownNow === null || shownNow === shown.diskText || shownNow === doc.buffer) return
        raiseConflict(doc, shownNow)
        changed(doc)
        throw new Error('another program changed the file again while you were choosing')
    }

    /**
     * **Keep mine**: the buffer goes over the version of the file the person was shown. A file that
     * has moved again since is shown to them instead, and nothing is written: writing then would
     * replace a version they were never shown.
     */
    async function keepMine(doc: OpenFile, shown: PlainConflict): Promise<void> {
        await untilWritten(async () => {
            const file = await readNow(doc)
            const read = file === null ? null : interpret(doc.path, file)
            askAgainIfMoved(doc, shown, read)
            // Their lines go into the file as it is now, so its own endings and mark are kept.
            if (read?.kind === 'text') {
                doc.diskText = read.text
                doc.form = read.form
            }
            const written = toWrite(doc, doc.buffer)
            const stamp = await writeOver(doc, read?.stamp ?? null, written)
            return stamp === null ? undefined : holdsNow(doc, written, stamp)
        })
    }

    /** **Take the disk's**: the buffer becomes the file, or the tab notes that the file went meanwhile. */
    function takeDisk(doc: OpenFile, file: FileBytes | null): void {
        if (file === null) {
            // Nothing to take: the file went while the person was choosing.
            doc.conflict = null
            doc.dirty = true
            noteRemoved(doc)
            return
        }
        adopt(doc, interpret(doc.path, file))
        notify(doc)
        changed(doc)
    }

    return {
        open(target) {
            const path = normalisePath(target)
            if (path === null || path === '') throw new DocumentNotFoundError(target)
            let doc = open.get(path)
            if (!doc) {
                doc = makeOpenFile(path)
                open.set(path, doc)
            }
            return doc.handle
        },

        async whenReady(path) {
            await fileAt(path)?.ready
        },

        async canonicalPath(path) {
            const normal = normalisePath(path)
            return normal === null ? null : adapter.canonicalPath(normal)
        },

        stateOf(path) {
            const doc = fileAt(path)
            if (!doc) return null
            return {
                path: doc.path,
                loaded: doc.loaded,
                missing: doc.missing,
                removedElsewhere: doc.removedElsewhere,
                readOnly: doc.readOnly,
                size: doc.size,
                dirty: doc.dirty,
                conflict: doc.conflict,
                error: doc.error,
            }
        },

        onStateChanged(listener) {
            stateListeners.add(listener)
            return () => stateListeners.delete(listener)
        },

        onDocumentRenamed(listener) {
            renameListeners.add(listener)
            return () => renameListeners.delete(listener)
        },

        async flushDocument(path) {
            const doc = fileAt(path)
            if (doc) await saveNow(doc)
        },

        async flushAll() {
            await Promise.all([...open.values()].map(saveNow))
        },

        unsavedPaths: () => [...open.values()].filter((doc) => doc.dirty).map((doc) => doc.path),

        async reconcile() {
            for (const doc of [...open.values()]) {
                try {
                    await reconcileFile(doc)
                } catch (error) {
                    // One unreadable file must not stop the pass over the others.
                    doc.error = error
                    changed(doc)
                }
            }
        },

        async resolveConflict(path, choice) {
            const doc = fileAt(path)
            if (!doc?.conflict) return
            if (choice === 'take-disk') return takeDisk(doc, await readNow(doc))
            await keepMine(doc, doc.conflict)
            doc.loaded = true
            doc.readOnly = null
            doc.missing = false
            doc.removedElsewhere = false
            doc.dirty = false
            doc.conflict = null
            doc.error = null
            changed(doc)
        },

        async restore(path) {
            const doc = fileAt(path)
            if (!doc || !(doc.removedElsewhere || doc.missing)) return
            // Something may be there again by now: that is a conflict to show, not a file to replace.
            if ((await adapter.stat(doc.path)) !== null) {
                await reconcileFile(doc)
                return
            }
            await adapter.createDirectory(dirOf(doc.path))
            const written = toWrite(doc, doc.buffer)
            const stamp = await writeOver(doc, null, written)
            if (stamp === null) {
                // Another program made the file as this one was about to.
                await reconcileFile(doc)
                return
            }
            holdsNow(doc, written, stamp)
            doc.loaded = true
            doc.missing = false
            doc.removedElsewhere = false
            doc.dirty = false
            doc.error = null
            changed(doc)
        },

        editAnyway(path) {
            const doc = fileAt(path)
            if (!doc || doc.readOnly !== 'too-large') return
            limitWaived.add(doc.path)
            doc.loaded = false
            doc.ready = hydrate(doc)
        },

        async settleUnder(path) {
            await Promise.all([...open.values()].filter((doc) => isUnder(doc.path, path)).map(saveNow))
        },

        moved(from, to) {
            for (const doc of [...open.values()]) {
                if (!isUnder(doc.path, from)) continue
                const before = doc.path
                const after = to + before.slice(from.length)
                open.delete(before)
                doc.path = after
                open.set(after, doc)
                if (limitWaived.delete(before)) limitWaived.add(after)
                for (const listener of renameListeners) listener(before, after)
                changed(doc)
            }
        },

        removed(path) {
            for (const doc of [...open.values()]) {
                if (!isUnder(doc.path, path)) continue
                doc.closed = true
                doc.save.cancel()
                open.delete(doc.path)
                limitWaived.delete(doc.path)
            }
        },

        openPaths() {
            return [...open.keys()]
        },

        async dispose() {
            await Promise.all([...open.values()].map(saveNow))
            for (const doc of open.values()) doc.closed = true
            open.clear()
            stateListeners.clear()
            renameListeners.clear()
        },
    }
}
