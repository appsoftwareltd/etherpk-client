/**
 * An interactive fence's widget drawn outside its document's editor: in a tab of its own or over the
 * whole window (`fence-hosting.ts`). The widget is the same one the editor draws, with
 * `presentation` `tab` or `window`, and it reads and changes the same text, through the document
 * store rather than an editor:
 *
 * - **Finding the fence.** By its info word and the id its registration reads from its body
 *   (`identify`), afresh after every change, since a fence's position moves with every edit above it.
 * - **Its edits.** Each is written as a text change at the fence's indentation, a replaced line with
 *   its line break as the editor writes it (`fenceEditChanges`), checked against what the widget read,
 *   and told to the document's other editors, so an open tab of the document shows it at once.
 * - **Other changes.** An editor's or another device's change reaches the widget as an `update` with
 *   the new body. When the fence is gone (deleted, or the document is gone) the host is told.
 *
 * Nothing is written to a document holding a Protected Document's cipher fence, where no widget is
 * drawn at all. Pure TypeScript over an {@link EditorDocument}, so it is tested in Node.
 */
import { type FenceBodyEdit, applyFenceBodyEdit, safeFenceLine } from '../fence-body'
import { containsCipherFence } from '../protection/fence-info'
import type { EditorDocument, TextChange } from '../types'
import { renderableFences } from './augmentations/fence-render-core'
import type { InteractiveFence, InteractiveFenceContext, InteractiveFenceView } from './augmentations/interactive-fence-contract'
import type { FenceRef } from './fence-hosting'

/** A fence found in a document's text, with what the edits need. */
export interface FoundFence {
    /** 0-based line index of the opener. */
    start: number
    /** 0-based line index of the closer. */
    end: number
    fenceColumn: number
    /** Opened on a bullet's line (form 1), whose marker stays when the fence goes. */
    bulletOpener: boolean
    body: string[]
    /** How many fences with the same info word come before it, as the editor counts them. */
    ordinal: number
}

/** The fence `ref` names in `text`, by its info word and its own id, or null. */
export function findFence(text: string, ref: Pick<FenceRef, 'info' | 'id'>, identify: (body: readonly string[]) => string | null): FoundFence | null {
    const lines = text.split('\n')
    let ordinal = 0
    for (const fence of renderableFences(lines)) {
        if (fence.info !== ref.info) continue
        const body = fence.end - fence.start > 1 ? fence.source.split('\n') : []
        let id: string | null = null
        try {
            id = identify(body)
        } catch {
            id = null
        }
        if (id === ref.id) return { start: fence.start, end: fence.end, fenceColumn: fence.fenceColumn, bulletOpener: fence.bulletOpener, body, ordinal }
        ordinal++
    }
    return null
}

/** Each line's start offset in `text`. */
function lineStarts(text: string): number[] {
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    return starts
}

/** The text change one edit makes to `fence` in `text`, as the editor writes it (`fenceEditChanges`). */
export function fenceEditTextChange(text: string, fence: FoundFence, edit: FenceBodyEdit): TextChange {
    const lines = text.split('\n')
    const starts = lineStarts(text)
    const indent = lines[fence.end].slice(0, fence.fenceColumn)
    if (edit.kind === 'insert') {
        const at = edit.line < fence.body.length ? starts[fence.start + 1 + edit.line] : starts[fence.end]
        return { from: at, to: at, insert: `${indent}${safeFenceLine(edit.text)}\n` }
    }
    const index = fence.start + 1 + edit.line
    const from = starts[index]
    const to = from + lines[index].length + 1
    if (edit.kind === 'replace') return { from, to, insert: `${indent}${safeFenceLine(edit.text)}\n` }
    return { from, to, insert: '' }
}

function applyText(text: string, change: TextChange): string {
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

/** Why a widget outside its editor is not drawn. */
export type DetachedFenceGone = 'gone' | 'protected'

export interface DetachedFenceOptions {
    /** The document the fence is in, opened through the graph's store. */
    doc: EditorDocument
    ref: FenceRef
    fence: InteractiveFence
    presentation: 'tab' | 'window'
    host: HTMLElement
    dark(): boolean
    onScreen(): boolean
    /**
     * The widget cannot be drawn, or no longer can: its fence was deleted, or its document was
     * (`gone`), or the document is a Protected Document, where no widget is drawn (`protected`).
     * Called before `mountDetachedFence` returns null, and whenever it happens later.
     */
    onGone(reason: DetachedFenceGone): void
    /** Close the window this widget fills (`window` only). */
    closeWindow?(): void
    /** Open the fence in a tab of its own. */
    openInTab?(): void
    /** Show the fence's text in its document's editor. */
    editAsText?(): void
}

export interface DetachedFence {
    /** The theme or whether the host can be seen changed: the widget is told. */
    refresh(): void
    destroy(): void
}

/**
 * Draw `options.fence`'s widget for the fence `options.ref` names, outside its editor, or say why
 * not (`onGone`) and return null.
 */
export function mountDetachedFence(options: DetachedFenceOptions): DetachedFence | null {
    const { doc, ref, fence } = options
    if (!fence.identify) {
        options.onGone('gone')
        return null
    }
    const identify = fence.identify.bind(fence)
    let text = doc.getText()
    // An unlocked Protected Document's text is its plaintext, which no extension is shown, as the
    // editor draws no widget in one (ADR 0118). A locked one holds its cipher fence.
    const protectedNow = () => (doc as { isProtected?: boolean }).isProtected === true || containsCipherFence(text)
    if (protectedNow()) {
        options.onGone('protected')
        return null
    }
    let found = findFence(text, ref, identify)
    if (!found) {
        options.onGone('gone')
        return null
    }
    let destroyed = false
    // The widget takes the keyboard as its tab or window opens, as a document tab's editor does,
    // and only then: a later `takeFocus` answers false, so an update never pulls the keyboard back.
    let focusOffered = true
    const takeFocus = () => {
        const offered = focusOffered
        focusOffered = false
        return offered
    }

    const writable = () => !protectedNow()
    const context = (): InteractiveFenceContext => ({
        info: ref.info,
        body: found?.body ?? [],
        document: ref.document,
        ordinal: found?.ordinal ?? 0,
        writable: writable(),
        dark: options.dark(),
        onScreen: options.onScreen(),
        presentation: options.presentation,
        edit: (change) => edit(Array.isArray(change) ? change : [change as FenceBodyEdit]),
        editAsText: () => options.editAsText?.(),
        remove: () => remove(),
        resized: () => {},
        takeFocus,
        openInTab: () => options.openInTab?.(),
        openWindow: () => {},
        closeWindow: () => options.closeWindow?.(),
    })

    /** Hears another editor's or device's change: the widget is told its fence's new body. */
    const listener = (next: string) => {
        if (destroyed || !found) return
        text = next
        if (protectedNow()) {
            found = null
            options.onGone('protected')
            return
        }
        const now = findFence(text, ref, identify)
        if (!now) {
            found = null
            options.onGone('gone')
            return
        }
        const changed = !found || now.body.length !== found.body.length || now.body.some((line, i) => line !== found!.body[i])
        found = now
        if (changed) view.update(context())
    }

    /**
     * Every edit is checked, and its text change worked out against the text the edits before it
     * leave, before any is written, so a list that cannot be made whole writes nothing. The changes
     * are then written one by one, each a whole line with its line break as the editor writes it:
     * merged into one change, a replacement would take in the untouched lines between two edits and
     * overwrite another device's change to them. Unlike the editor's, they are not one undo step,
     * since no editor's history holds them (a widget that needs undo here keeps its own).
     */
    function edit(edits: readonly FenceBodyEdit[]): boolean {
        if (destroyed || !found || !writable()) return false
        let body: string[] | null = found.body
        for (const one of edits) {
            body = body ? applyFenceBodyEdit(body, one) : null
            if (!body) return false
        }
        const changes: TextChange[] = []
        let scratch = text
        let current: FoundFence = found
        for (const one of edits) {
            const change = fenceEditTextChange(scratch, current, one)
            scratch = applyText(scratch, change)
            const next = findFenceAt(scratch, current.start, current.ordinal)
            if (!next) return false
            changes.push(change)
            current = next
        }
        for (const change of changes) {
            // Told to the document's other editors, which show it; this host knows it already.
            doc.applyChange(change, 'editor', listener)
        }
        text = scratch
        found = current
        view.update(context())
        return true
    }

    function remove(): boolean {
        if (destroyed || !found || !writable()) return false
        // As the editor removes one (`fenceRemoval`): its lines and the break after them, or for a
        // fence opened on a bullet's line the fence alone, leaving the bullet empty.
        const starts = lineStarts(text)
        const lines = text.split('\n')
        const closerEnd = starts[found.end] + lines[found.end].length
        const change = found.bulletOpener
            ? { from: starts[found.start] + found.fenceColumn, to: closerEnd, insert: '' }
            : { from: starts[found.start], to: Math.min(text.length, closerEnd + 1), insert: '' }
        text = applyText(text, change)
        doc.applyChange(change, 'editor', listener)
        found = null
        options.onGone('gone')
        return true
    }

    const unsubscribe = doc.subscribe(listener)
    let view: InteractiveFenceView
    try {
        view = fence.mount(options.host, context())
    } catch (error) {
        unsubscribe()
        throw error
    }
    return {
        refresh() {
            if (!destroyed && found) view.update(context())
        },
        destroy() {
            if (destroyed) return
            destroyed = true
            unsubscribe()
            view.destroy()
        },
    }
}

/**
 * The fence opening on line `start` of `text`, after an edit inside it, which never moves its opener
 * nor changes how many fences come before it.
 */
function findFenceAt(text: string, start: number, ordinal: number): FoundFence | null {
    const lines = text.split('\n')
    const fence = renderableFences(lines).find((candidate) => candidate.start === start)
    if (!fence) return null
    return {
        start: fence.start,
        end: fence.end,
        fenceColumn: fence.fenceColumn,
        bulletOpener: fence.bulletOpener,
        body: fence.end - fence.start > 1 ? fence.source.split('\n') : [],
        ordinal,
    }
}
