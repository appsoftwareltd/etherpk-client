/**
 * The open [[Kanban Board]]s, by the id each registers under, so a row of a card's context menu
 * can act through the board that raised it (ADR 0113). The board holds the moves the index has
 * not confirmed yet, and a move made anywhere else would not show on it until the index caught up.
 *
 * A rename reaches the boards here too, as the `concept:renamed` Event (register.ts): a
 * [[Task Detail]] showing a renamed document follows it, and a board re-keyed because its own
 * concept was renamed starts where the board it replaces left off.
 */
import { conceptKey } from '$lib/document/backlinks'
import type { BoardCell } from './board-model'
import type { BoardState } from './board-state'

/** What a menu row can ask of a board, about one of its cards, named by its key. */
export interface BoardActions {
    /** Show the card's task, as clicking the card does. */
    open(card: string): void
    /** Open the task's document in a tab of its own, at the task's line. */
    openInTab(card: string): void
    /** Copy a [[Task Reference]] to the card's task, to hand it to an agent (ADR 0114). */
    copyReference(card: string): void
    /** Move the card to another lane or section. */
    move(card: string, to: BoardCell): void
}

/** What a rename or a removal of documents asks of a board. */
export interface BoardDocuments {
    /** The concept the board is over. */
    concept: string
    /** A document was renamed: a Task Detail showing it follows it to its new name. */
    documentRenamed(from: string, to: string): void
    /** A document was removed: a Task Detail showing it closes, unless it is being typed in. */
    documentRemoved(document: string): void
    /** The board's state now, its Task Detail at the line it shows the task on: what a board re-keyed from it starts in. */
    state(): BoardState
}

interface RegisteredBoard {
    actions: BoardActions
    documents?: BoardDocuments
}

const boards = new Map<string, RegisteredBoard>()

/** Register a board's actions under `id`; the returned function takes them away again. */
export function registerBoard(id: string, actions: BoardActions, documents?: BoardDocuments): () => void {
    const entry: RegisteredBoard = { actions, documents }
    boards.set(id, entry)
    return () => {
        if (boards.get(id) === entry) boards.delete(id)
    }
}

export function boardActions(id: string): BoardActions | undefined {
    return boards.get(id)?.actions
}

/** Tell every open board that a document was removed, so a Task Detail showing it closes as its tab does. */
export function documentRemoved(document: string): void {
    for (const { documents } of boards.values()) documents?.documentRemoved(document)
}

/** States handed from a board a rename is replacing to the board replacing it, by the new concept's key. */
const handovers = new Map<string, BoardState>()

/**
 * The concept `from` became `to` (the `concept:renamed` Event, once for each concept a rename
 * moved, under the exact name it lives on as). A Task Detail showing `from` follows it first.
 * Then a board over `from` hands its state to the board the Layout is about to open over `to`,
 * which is a new View and would start from nothing: it takes the old board's folded lanes, its
 * Task Detail and its height instead (`takeBoardHandover`).
 *
 * In that order, so the handover carries the Task Detail where it now is, and the rename is
 * applied to it once: again, a new name the old one scopes (`Acme` to `[[Acme]] Archive`) would
 * be renamed a second time.
 */
export function conceptRenamed(from: string, to: string): void {
    for (const { documents } of boards.values()) documents?.documentRenamed(from, to)
    for (const { documents } of boards.values()) {
        if (documents && conceptKey(documents.concept) === conceptKey(from)) handovers.set(conceptKey(to), documents.state())
    }
}

/** The state a rename handed to the board over `concept`, once. */
export function takeBoardHandover(concept: string): BoardState | undefined {
    const key = conceptKey(concept)
    const state = handovers.get(key)
    handovers.delete(key)
    return state
}
