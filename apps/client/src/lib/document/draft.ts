/**
 * A [[Draft]] (CONTEXT.md, ADR 0050): the editable surface a [[Pageless Concept]] opens as.
 *
 * A Draft is an ordinary {@link EditorDocument} backed by nothing but a string, so
 * `DocumentView` mounts it through the same path as a real document and the Backlinks View
 * lights up for its concept without knowing the difference. Navigating to one writes nothing.
 * The FIRST change to its text promotes it: the page is created, seeded with the buffer, and
 * the view rebinds to the real document.
 *
 * The promotion itself lives in `promoteDraft` rather than in the handle, because the handle
 * must stay synchronous — CodeMirror's own state IS the buffer, which is what makes the async
 * gap safe. Nothing is racing the user's typing; it is replayed.
 */

import { isJournalConcept } from './journal-concept'
import type { DocumentStore, EditorDocument } from './types'

/** A store that can bring a document into existence — the Filesystem and Server Backends. */
export interface DocumentCreatingStore extends DocumentStore {
    createPage(title: string, body?: string): Promise<string>
    createJournal(date: string, body?: string): Promise<string>
}

export function canCreateDocuments(store: DocumentStore): store is DocumentCreatingStore {
    const s = store as Partial<DocumentCreatingStore>
    return typeof s.createPage === 'function' && typeof s.createJournal === 'function'
}

export interface DraftDocument extends EditorDocument {
    readonly isDraft: true
    /** The concept this Draft promotes to — the name the page will be given. */
    readonly concept: string
    /** True once anything has been typed; an empty Draft is safe to discard silently. */
    hasContent(): boolean
}

/**
 * A Draft handle over `concept`.
 *
 * `onFirstChange` fires exactly once, on the first change that actually alters the text.
 * Selection and cursor movement never reach here (CodeMirror only reports document changes),
 * but a no-op change — replacing a range with itself — would, so it is filtered out: promotion
 * must mean content, not activity.
 */
export function createDraftDocument(concept: string, onFirstChange: () => void): DraftDocument {
    let buffer = ''
    let promotionRequested = false
    const listeners = new Set<(text: string) => void>()

    return {
        isDraft: true,
        concept,
        id: concept,
        getText: () => buffer,
        hasContent: () => buffer !== '',
        applyChange(change) {
            const next = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to)
            if (next === buffer) return
            buffer = next
            if (!promotionRequested) {
                promotionRequested = true
                onFirstChange()
            }
        },
        subscribe(listener) {
            // A Draft has no external source to hear from — it exists only here. The
            // subscription is honoured anyway so DocumentView needs no special case.
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

/**
 * The text a document holds, once it actually holds it.
 *
 * The two backends disagree about when `open()` has content. A [[Server Backend]] answers
 * `whenReady`; a [[Filesystem Backend]] returns an empty buffer and pushes the file's text
 * through `subscribe` when its read lands. Promotion has to know the real text before it can
 * work out where the body starts, so this normalises the two.
 */
export function whenDocumentText(
    store: DocumentStore,
    doc: EditorDocument,
    target: string,
    timeoutMs = 2000,
): Promise<string> {
    const ready = store.whenReady?.(target)
    if (ready) return ready.then(() => doc.getText())
    const current = doc.getText()
    if (current !== '') return Promise.resolve(current)
    return new Promise((resolve) => {
        let done = false
        const finish = (text: string) => {
            if (done) return
            done = true
            clearTimeout(timer)
            unsubscribe()
            resolve(text)
        }
        const unsubscribe = doc.subscribe(finish)
        // A genuinely empty document never notifies. Settle on what is there rather than
        // hanging the promotion forever.
        const timer = setTimeout(() => finish(doc.getText()), timeoutMs)
    })
}

export interface PromotedDraft {
    /** The concept that now has a page — the Draft's, or the one it adopted. */
    concept: string
    /** The promoted document's full text, body seeded from the Draft. */
    text: string
    /**
     * How many characters precede the Draft's own text. A [[Filesystem Backend]] writes a
     * frontmatter `title` block ahead of the body, so a caret at offset N in the Draft is at
     * `bodyOffset + N` in the promoted document; on a [[Server Backend]] it is 0.
     */
    bodyOffset: number
}

/**
 * Bring a Draft's document into existence and reconcile anything typed while that was in flight.
 *
 * The create seeds the body in one write, so the common case needs no second pass. Keystrokes
 * landing during the gap — a [[Filesystem Backend]]'s create is a directory write plus a full
 * registry refresh — are caught by re-reading the Draft afterwards and replacing the body range.
 *
 * A create that fails because the concept now exists (a second tab, or a [[Player]] who got there
 * first) is not an error: the Draft **adopts** that document and appends its text. That covers a
 * day as well as a name, which is what makes reaching a journal entry race-free now that nothing
 * pre-creates one.
 */
export async function promoteDraft(
    store: DocumentCreatingStore,
    draft: DraftDocument,
): Promise<PromotedDraft> {
    const seeded = draft.getText()
    let adopted = false
    try {
        // The CONCEPT decides which kind comes into existence, never the surface the Draft was
        // opened from (ADR 0056): a day becomes that day's [[Journal Entry]], anything else a
        // [[Page]]. So a date reached from the [[Journal Calendar]], a wikilink and [[Quick Find]]
        // all land in the same place.
        if (isJournalConcept(draft.concept)) await store.createJournal(draft.concept, seeded)
        else await store.createPage(draft.concept, seeded)
    } catch {
        // Already exists, or the store refused the name. Either way the concept is reachable
        // or it is not, and `open` below decides which — never swallow the user's text.
        adopted = true
    }

    const doc = store.open(draft.concept)
    const opened = await whenDocumentText(store, doc, draft.concept)

    if (adopted) {
        // We seeded nothing, so the Draft's text is appended whole, after a separating blank
        // line when the adopted document already has content. Nothing is overwritten: a
        // [[Merge]] loses nothing, at a much smaller scale (ADR 0038).
        const current = draft.getText()
        if (current === '') return { concept: draft.concept, text: opened, bodyOffset: opened.length }
        const separator = opened === '' || opened.endsWith('\n') ? '' : '\n'
        const insert = `${separator}${current}`
        doc.applyChange({ from: opened.length, to: opened.length, insert })
        return {
            concept: draft.concept,
            text: opened + insert,
            bodyOffset: opened.length + separator.length,
        }
    }

    // `opened` is prefix + seeded, so everything before the seeded text is the prefix.
    const bodyOffset = Math.max(0, opened.length - seeded.length)
    const current = draft.getText()
    if (current === seeded) return { concept: draft.concept, text: opened, bodyOffset }

    // Typed during the gap. Replace the body range wholesale — exact, and cheap at these sizes.
    doc.applyChange({ from: bodyOffset, to: opened.length, insert: current })
    return { concept: draft.concept, text: opened.slice(0, bodyOffset) + current, bodyOffset }
}
