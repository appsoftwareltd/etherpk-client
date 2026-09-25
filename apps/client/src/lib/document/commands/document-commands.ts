/**
 * Document-scoped [[Command]]s reachable from a [[Context Menu]]: showing a document's backlinks,
 * favouriting, renaming, deleting, and copying a document's name or its full path on disk.
 *
 * These are Commands rather than inline handlers so the [[Context Menu]] stays a
 * *presentation surface* over the Command registry - the same relationship the
 * [[Command Menu]] and [[Command Bar]] already have - and so a keybinding or a menu item can
 * reach them later without touching the Sidebar.
 *
 * Each takes a {@link ContextMenuTarget} as its argument, because a Context Menu acts on a
 * target rather than on whatever is focused.
 */

import {
    type ContextMenuTarget,
    type CommandRegistry,
    type ContributionRegistry,
    isDocumentTarget,
    isWikilinkTarget,
    registerContextMenuItem,
} from '$lib/surface'

import { addFavourite, isFavourite, moveFavourite, removeFavourite } from '../favourites'
import { isJournalConcept } from '../journal-concept'
import { copyFailureMessage, writeClipboardText } from './clipboard-text'

export const FAVOURITE_ADD = 'favourites.add'
export const FAVOURITE_REMOVE = 'favourites.remove'
export const FAVOURITE_MOVE = 'favourites.move'
export const DOCUMENT_RENAME = 'document.rename'
export const DOCUMENT_DELETE = 'document.delete'
export const DOCUMENT_COPY_FILE_PATH = 'document.copyFilePath'
/**
 * Put a document's name on the clipboard, exactly as its tab shows it: what a wikilink typed
 * elsewhere, or a message to someone, needs. Resolves `true` once the name is on the clipboard.
 */
export const DOCUMENT_COPY_NAME = 'document.copyName'
/** Open the Publish dialog for a document: its `public` switch and the publications it belongs to (ADR 0082). */
export const DOCUMENT_PUBLISH = 'document.publish'
/**
 * Show a concept's backlinks: the Backlinks View showing it, brought to the front, its pin left
 * as it is (ADR 0088). Beside `backlinks.open` (Alt+B), which reveals the View on whatever it is
 * showing.
 */
export const BACKLINKS_SHOW = 'backlinks.show'

function conceptOf(arg: unknown): string {
    const target = arg as ContextMenuTarget | undefined
    if (!target) return ''
    // A document target, or a wikilink's concept (ADR 0065): Rename… acts on either.
    return (isDocumentTarget(target) || isWikilinkTarget(target)) && typeof target.concept === 'string'
        ? target.concept
        : ''
}

/** `favourites.move`'s argument: where a favourite should sit in the list, 0-based. */
export interface FavouriteMoveArg {
    concept: string
    toIndex: number
}

function moveArgOf(arg: unknown): FavouriteMoveArg | null {
    const move = arg as Partial<FavouriteMoveArg> | undefined
    return move && typeof move.concept === 'string' && typeof move.toIndex === 'number'
        ? { concept: move.concept, toIndex: move.toIndex }
        : null
}

export interface DocumentCommandDeps {
    /** Opens the rename dialog for a concept; the workspace owns the dialog. */
    promptRename: (concept: string) => void
    /** Opens the delete confirmation; the workspace owns the dialog. */
    promptDelete: (concept: string) => void
    /** Open the Publish dialog for a document. Absent where publishing is not offered (a dev harness). */
    promptPublish?: (concept: string) => void
    /**
     * Show a concept in the Backlinks View and bring it to the front. The workspace owns what
     * that does to the View's state (`backlinks-preferences.ts`) and the reveal; absent where
     * there is no Backlinks View.
     */
    showBacklinks?: (concept: string) => void
    /** Surfaces a failure to the user (the workspace's status line). */
    onError?: (message: string) => void
    /**
     * Confirms a copy to the user, through the same status line. The clipboard shows nothing,
     * so without it a copy that worked looks exactly like one that never happened.
     */
    onCopied?: (message: string) => void
    /**
     * Whether the document has a file on disk this device can name - a [[Filesystem Backend]]
     * graph's document. Absent ⇒ never, which is what a Server graph supplies: its documents
     * live in the browser and on the Sync Server, and no path would mean anything.
     */
    hasFilePath?: (concept: string) => boolean
    /**
     * Copies the document's full path on this device to the clipboard, asking for the graph
     * folder's path first when this device does not know it yet. The workspace owns both the
     * clipboard write and that prompt.
     */
    copyFilePath?: (concept: string) => void
}

/**
 * Register the document Commands and their Context Menu rows. Returns a disposer.
 *
 * The add/remove pair is two registrations rather than one toggle: a menu row should say
 * what it will do, and "Add to favourites" / "Remove from favourites" read far better than
 * a single "Toggle favourite". Their `when` predicates are exact complements, so exactly one
 * ever shows.
 */
export function registerDocumentCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: DocumentCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    const guard = async (work: Promise<void>) => {
        try {
            await work
        } catch (err) {
            deps.onError?.((err as Error).message)
        }
    }

    disposers.push(
        commands.register(FAVOURITE_ADD, (arg) => guard(addFavourite(conceptOf(arg)))),
        commands.register(FAVOURITE_REMOVE, (arg) => guard(removeFavourite(conceptOf(arg)))),
        // Not a Context Menu row: this is how the Sidebar's drag handle and its arrow keys write
        // the order, so a refused write reaches the user the same way a refused add does.
        commands.register(FAVOURITE_MOVE, (arg) => {
            const move = moveArgOf(arg)
            return move ? guard(moveFavourite(move.concept, move.toIndex)) : undefined
        }),
        commands.register(DOCUMENT_RENAME, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.promptRename(concept)
        }),
        commands.register(DOCUMENT_DELETE, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.promptDelete(concept)
        }),
        commands.register(DOCUMENT_PUBLISH, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.promptPublish?.(concept)
        }),
        commands.register(DOCUMENT_COPY_FILE_PATH, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.copyFilePath?.(concept)
        }),
        // Written here rather than handed to the workspace like the path: a name needs nothing
        // the workspace owns (no folder path, no store lookup), so the whole behaviour is
        // testable in this module. Nothing is awaited before the write, which has to start
        // inside the menu click (clipboard-text.ts).
        commands.register(DOCUMENT_COPY_NAME, async (arg) => {
            const concept = conceptOf(arg)
            if (concept === '') return false
            try {
                await writeClipboardText(concept)
            } catch (err) {
                deps.onError?.(copyFailureMessage('name', err, concept))
                return false
            }
            deps.onCopied?.(`Copied "${concept}"`)
            return true
        }),
        commands.register(BACKLINKS_SHOW, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.showBacklinks?.(concept)
        }),
    )

    disposers.push(
        registerContextMenuItem(contributions, {
            id: BACKLINKS_SHOW,
            label: 'Show backlinks',
            command: BACKLINKS_SHOW,
            // First: a read, and the one row that changes nothing. On a tab it acts on the tab's
            // document whether or not that tab is in front; on a wikilink, on the concept the
            // link names - the innermost link under the pointer, as a click resolves it. The
            // Sidebar rows (Favourites, Recents, All Documents) could carry it too, but have
            // not been asked for.
            order: 5,
            when: (target) =>
                (target.kind === 'document-tab' || isWikilinkTarget(target)) && deps.showBacklinks !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: FAVOURITE_ADD,
            label: 'Add to favourites',
            command: FAVOURITE_ADD,
            order: 10,
            when: (target) => isDocumentTarget(target) && !isFavourite(target.concept),
        }),
        registerContextMenuItem(contributions, {
            id: FAVOURITE_REMOVE,
            label: 'Remove from favourites',
            command: FAVOURITE_REMOVE,
            order: 10,
            when: (target) => isDocumentTarget(target) && isFavourite(target.concept),
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_RENAME,
            label: 'Rename…',
            command: DOCUMENT_RENAME,
            order: 20,
            separatorBefore: true,
            // A Journal Entry's name IS its date; renaming one is refused at the store, but
            // it should not be offered in the first place. Offered on a wikilink too (ADR 0065):
            // a rename acts on the concept, and a link names one.
            when: (target) =>
                (isDocumentTarget(target) || isWikilinkTarget(target)) && !isJournalConcept(target.concept),
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_PUBLISH,
            label: 'Publish…',
            command: DOCUMENT_PUBLISH,
            order: 25,
            // On the document itself, not on a wikilink: the dialog writes the document's own
            // frontmatter, and a link names a concept that may have no document yet.
            when: (target) => isDocumentTarget(target) && deps.promptPublish !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_DELETE,
            label: 'Delete…',
            command: DOCUMENT_DELETE,
            order: 30,
            when: isDocumentTarget,
            // Grouped away from the constructive actions: a destructive row sitting flush
            // against "Rename" is one mis-click from an irreversible delete (ADR 0039 §3).
            separatorBefore: true,
        }),
        // The copy rows: the last group, after the tab-management rows (tab-commands.ts,
        // 90-120). Both hand the document to something outside the app - a wikilink typed
        // elsewhere, an AI agent, another editor - which is a different errand from everything
        // above them. The group's separator sits on the name row because it always shows; the
        // path row joins it only where there is a file.
        registerContextMenuItem(contributions, {
            id: DOCUMENT_COPY_NAME,
            label: 'Copy name to clipboard',
            command: DOCUMENT_COPY_NAME,
            order: 190,
            separatorBefore: true,
            // Every document tab has a name, whatever holds the document: a synced graph, a
            // folder graph, or nothing yet (a [[Draft]], before its first edit writes it). The
            // tab only, like the path row below: the Sidebar rows have not been asked for.
            when: (target) => target.kind === 'document-tab',
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_COPY_FILE_PATH,
            label: 'Copy full file path to clipboard',
            command: DOCUMENT_COPY_FILE_PATH,
            // Directly below Copy name, in its group (see above).
            order: 200,
            // The tab only: the row names the file behind the editor you are looking at. A
            // Favourites or Recents row could carry it too, but has not been asked for.
            when: (target) =>
                target.kind === 'document-tab' && (deps.hasFilePath?.(target.concept) ?? false),
        }),
    )

    return () => {
        for (const dispose of disposers) dispose()
    }
}

