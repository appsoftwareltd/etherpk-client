/**
 * A [[Draft]] (CONTEXT.md, ADR 0050): the editable surface a [[Pageless Concept]] opens as.
 *
 * A Draft is an ordinary {@link EditorDocument} backed by nothing but a string, so
 * `DocumentView` mounts it through the same path as a real document and the Backlinks View
 * lights up for its concept without knowing the difference. Navigating to one writes nothing.
 * The FIRST change to its text promotes it: the page is created, seeded with the buffer, and
 * the view rebinds to the real document. A change made while the Command Menu is open is held
 * instead (`hold`), since the command may take its own text back out, as /Agent does: the Draft
 * is promoted when the menu closes only if its text then differs from its starting text (ADR 0145,
 * amended 2026-10-16).
 *
 * The promotion itself lives in `promoteDraft` rather than in the handle, because the handle
 * must stay synchronous — CodeMirror's own state IS the buffer, which is what makes the async
 * gap safe. Nothing is racing the user's typing; it is replayed.
 */

import { parseFrontmatter } from '../storage/fs/frontmatter'
import { isJournalConcept } from './journal-concept'
import type { DocumentStore, EditorDocument, TextChange } from './types'

/** A store that can bring a document into existence — the Filesystem and Server Backends. */
export interface DocumentCreatingStore extends DocumentStore {
    createPage(title: string, body?: string): Promise<string>
    /**
     * `options.template` names the [[Journal Template]] that `body` starts with, which a [[Server
     * Backend]] seeds as one identical CRDT write so two devices that start the day hold it once
     * (ADR 0157). A [[Filesystem Backend]] has no use for it.
     */
    createJournal(date: string, body?: string, options?: { template?: string }): Promise<string>
}

export function canCreateDocuments(store: DocumentStore): store is DocumentCreatingStore {
    const s = store as Partial<DocumentCreatingStore>
    return typeof s.createPage === 'function' && typeof s.createJournal === 'function'
}

export interface DraftDocument extends EditorDocument {
    readonly isDraft: true
    /** The concept this Draft promotes to — the name the page will be given. */
    readonly concept: string
    /**
     * True once anything has been typed; a Draft holding nothing, or only the text it was seeded
     * with, is safe to discard silently.
     */
    hasContent(): boolean
    /**
     * Fill an untouched Draft with starting text: the [[Journal Template]] a new day opens holding
     * (ADR 0145). It reaches the editor as a document's content does, through `subscribe`, so it
     * is no edit and writes nothing; the first edit promotes the Draft with this text in it.
     * Refused, returning false, once anything has been typed or a seed has been taken. A change
     * taken in by `absorb` (a placement) is not typing, and the seed replaces it.
     */
    seed(text: string): boolean
    /** The text `seed` gave the Draft, or `''`. */
    seeded(): string
    /**
     * Take in a change that only rode on a caret move: tidy on leave trimming a line the caret left.
     * The buffer follows the editor, but nothing is written, since only an edit creates the
     * document (ADR 0050, ADR 0145). Before any edit the change is part of the starting text, so the
     * Draft still counts as untouched, unless a command's text is held, which never becomes part of it.
     */
    absorb(change: TextChange): void
    /**
     * Take in a change made while the Command Menu is open, without creating the document: the
     * command may take its own text back out as it runs. DocumentView holds every such change and
     * calls `release` when the menu closes.
     */
    hold(change: TextChange): void
    /**
     * The Command Menu closed: create the document now if its text differs from its starting text,
     * as when Escape closed the menu on a half-typed command, or the view is going away with one.
     */
    release(): void
    /** Whether a change made while the Command Menu was open is waiting for it to close. */
    isHolding(): boolean
}

/**
 * A Draft handle over `concept`.
 *
 * `onFirstChange` fires exactly once, on the first edit that leaves the text other than its
 * starting text, or on `release` when held text is left. Selection and cursor movement never reach
 * here (CodeMirror only reports document changes), but a no-op change (replacing a range with
 * itself) would, so it is filtered out: promotion must mean content, not activity.
 */
export function createDraftDocument(concept: string, onFirstChange: () => void): DraftDocument {
    let buffer = ''
    let seededText = ''
    let promotionRequested = false
    /** A change made while the Command Menu was open waits for it to close. */
    let holding = false
    /** A command was typed: the Draft takes no starting text after that. */
    let commandTyped = false
    /** The starting text has been given (`seed`): there is only ever one. */
    let seedTaken = false
    const listeners = new Set<(text: string) => void>()
    const promoteIfChanged = () => {
        if (promotionRequested || buffer === seededText) return
        promotionRequested = true
        onFirstChange()
    }

    return {
        isDraft: true,
        concept,
        id: concept,
        getText: () => buffer,
        hasContent: () => buffer !== seededText,
        seed(text) {
            // Typed text is the only thing that leaves the buffer other than its starting text; a
            // placement `absorb` took in (an untouched end-of-document line) is still starting text.
            if (promotionRequested || commandTyped || seedTaken || buffer !== seededText || text === '') return false
            seedTaken = true
            buffer = seededText = text
            for (const listener of listeners) listener(text)
            return true
        },
        seeded: () => seededText,
        absorb(change) {
            buffer = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to)
            if (!promotionRequested && !holding) seededText = buffer
        },
        applyChange(change) {
            const next = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to)
            if (next === buffer) return
            buffer = next
            holding = false
            promoteIfChanged()
        },
        hold(change) {
            buffer = buffer.slice(0, change.from) + change.insert + buffer.slice(change.to)
            holding = true
            commandTyped = true
        },
        release() {
            if (!holding) return
            holding = false
            promoteIfChanged()
        },
        isHolding: () => holding,
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
        // [[Page]]. So a date reached from the [[Journal Calendar]], a wikilink and [[Search]]
        // all land in the same place.
        if (isJournalConcept(draft.concept)) await store.createJournal(draft.concept, seeded, { template: draft.seeded() })
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
        // [[Merge]] loses nothing, at a much smaller scale (ADR 0038). A Draft that opened
        // holding a [[Journal Template]] (ADR 0145) leaves out the Template when the adopted day
        // already starts with it, so a day two devices opened at once does not hold it twice.
        const current = withoutSharedStart(draft.getText(), draft.seeded(), opened)
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

    // The seeded text is one run in `opened`: after a Filesystem Backend's frontmatter prefix, and
    // on a Server Backend wherever the day's other text left it. A journal entry's document id is
    // derived from its day (ADR 0157), so it can already hold, or receive meanwhile, the text
    // another device wrote into the same day, before or after this Draft's.
    const at = opened.endsWith(seeded) ? opened.length - seeded.length : opened.indexOf(seeded)
    const current = draft.getText()
    if (at < 0) {
        // Another device wrote inside this Draft's text while the create was in flight, so there
        // is no run to replace. What was typed since is added at the end: nothing is lost.
        const typed = current.startsWith(seeded) ? current.slice(seeded.length) : current === seeded ? '' : current
        if (typed === '') return { concept: draft.concept, text: opened, bodyOffset: 0 }
        doc.applyChange({ from: opened.length, to: opened.length, insert: typed })
        return { concept: draft.concept, text: opened + typed, bodyOffset: opened.length }
    }
    if (current === seeded) return { concept: draft.concept, text: opened, bodyOffset: at }

    // Typed during the gap. Replace the seeded run wholesale — exact, and cheap at these sizes —
    // and only that run, so text around it that another device wrote stays.
    doc.applyChange({ from: at, to: at + seeded.length, insert: current })
    return { concept: draft.concept, text: opened.slice(0, at) + current + opened.slice(at + seeded.length), bodyOffset: at }
}

/**
 * The part of a seeded Draft's text to append to a document it adopted: all of it, unless both
 * start with the text the Draft was seeded with, which the document then already holds. The text
 * after the seed is kept from its first character, so nothing typed is lost; a seed the person
 * edited no longer starts the Draft's text, which is then appended whole.
 */
function withoutSharedStart(text: string, seeded: string, adopted: string): string {
    // A journal entry carries frontmatter only when it has aliases; the body is what a seed fills.
    if (seeded === '' || !text.startsWith(seeded) || !parseFrontmatter(adopted).body.startsWith(seeded)) return text
    return text.slice(seeded.length).replace(/^\r?\n/, '')
}
