/**
 * The [[Quick Notes View]]'s one shared [[Command]]: move every [[Quick Note]] into today's
 * [[Journal Entry]] (ADR 0078). Registered as a Command so the View's button, the Command
 * Menu row and any keybinding all run the same code and refuse the same way.
 *
 * Adding and deleting a note stay local to the View: they need the box's text or a note id,
 * and nothing outside the View has either.
 */

import {
    type CommandRegistry,
    type ContributionRegistry,
    registerCommandMenuItem,
} from '$lib/surface'

import { formatISODate, todayISO } from '../calendar/month-grid-core'
import { canCreateDocuments, type DocumentCreatingStore, whenDocumentText } from '../draft'
import { getQuickNotes, removeQuickNotes } from '../quick-notes'
import { journalSeparator, quickNotesAsJournalBlocks } from '../quick-notes-journal'
import type { DocumentStore } from '../types'

export const QUICK_NOTES_MOVE = 'quickNotes.moveToJournal'
/** Focuses the resident and its box; registered by the workspace, which owns the Layout. */
export const QUICK_NOTES_OPEN = 'quickNotes.open'

export interface MoveQuickNotesOptions {
    /** The day the notes land in. Read at the moment of the move, never cached (a tab lives for days). */
    today?: () => string
    /** The day a note was written, from its instant. Local time, like every journal name. */
    dayOf?: (createdAt: number) => string
}

export interface MoveQuickNotesOutcome {
    moved: number
    /** The [[Journal Concept]] the notes went to. */
    concept: string
}

/** Local time: a note written at 23:50 belongs to the day the writer was living in. */
function localDayOf(createdAt: number): string {
    return formatISODate(new Date(createdAt))
}

/**
 * Append the notes to today's entry and then delete them - in that order, so a failed write
 * leaves every note where it was. The set moved is the set read at the start: a note that
 * arrives from a peer while the write is in flight is not in the text, so it is not deleted.
 *
 * Create-or-adopt mirrors `promoteDraft`: `createJournal` when the day has no entry, and when
 * that refuses because one exists (a peer, a second tab, or simply an entry written earlier
 * today) the text is appended after one blank line as an `'external'` change, so an open
 * editor on the entry sees it land.
 */
export async function moveQuickNotesToJournal(
    store: DocumentCreatingStore,
    options: MoveQuickNotesOptions = {},
): Promise<MoveQuickNotesOutcome> {
    const today = options.today ?? todayISO
    const dayOf = options.dayOf ?? localDayOf
    const concept = today()
    // Oldest first: the order they are written in, and the order they are deleted in.
    const notes = getQuickNotes().sort((a, b) => a.createdAt - b.createdAt)
    if (notes.length === 0) return { moved: 0, concept }
    const blocks = quickNotesAsJournalBlocks(notes, dayOf)

    let adopted = false
    try {
        await store.createJournal(concept, blocks)
    } catch {
        // Exists already (or the store refused). `open` below decides which: a refusal
        // surfaces from there, and nothing has been deleted yet.
        adopted = true
    }
    if (adopted) {
        const doc = store.open(concept)
        const existing = await whenDocumentText(store, doc, concept)
        const insert = `${journalSeparator(existing)}${blocks}`
        doc.applyChange({ from: existing.length, to: existing.length, insert }, 'external')
    }

    await removeQuickNotes(notes.map((n) => n.id))
    return { moved: notes.length, concept }
}

export interface QuickNotesCommandDeps {
    /** The open graph's store, when there is one. */
    store: () => DocumentStore | undefined
    /** Opens (and focuses) the entry the notes went to, so the result is on screen. */
    openConcept: (concept: string) => void
    /** Surfaces a failure to the user (the workspace's notice). */
    onError?: (message: string) => void
    /** A successful move, with the count - for a confirmation the user can't otherwise see. */
    onMoved?: (moved: number) => void
    today?: () => string
    dayOf?: (createdAt: number) => string
}

/** Register the move Command and its Command Menu row. Returns a disposer. */
export function registerQuickNotesCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: QuickNotesCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    disposers.push(
        commands.register(QUICK_NOTES_MOVE, async () => {
            const store = deps.store()
            if (!store || !canCreateDocuments(store)) {
                deps.onError?.('Could not move quick notes: this graph cannot create a journal entry.')
                return
            }
            try {
                const outcome = await moveQuickNotesToJournal(store, { today: deps.today, dayOf: deps.dayOf })
                if (outcome.moved === 0) return
                deps.onMoved?.(outcome.moved)
                deps.openConcept(outcome.concept)
            } catch (err) {
                deps.onError?.(`Could not move quick notes: ${(err as Error).message}`)
            }
        }),
        registerCommandMenuItem(contributions, {
            id: QUICK_NOTES_MOVE,
            title: "Move quick notes to today's journal",
            detail: 'Under the day each was written',
            icon: 'today',
            group: 'Journal',
            keywords: ['quick', 'notes', 'capture', 'journal', 'move'],
            // Not gated on `bodyWritable`: the write goes to today's entry, not the document
            // the menu was opened in.
            when: () => getQuickNotes().length > 0,
            command: QUICK_NOTES_MOVE,
        }),
    )

    return () => disposers.forEach((off) => off())
}
