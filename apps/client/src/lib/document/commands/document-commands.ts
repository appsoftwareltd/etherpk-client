/**
 * Document-scoped [[Command]]s reachable from a [[Context Menu]]: opening a linked concept, or a
 * [[Backlink]]'s document, in the Pane to the right or below, showing a document's backlinks or its tasks, favouriting, renaming, deleting,
 * and copying a document's name or its full path on disk.
 *
 * These are Commands rather than inline handlers so the [[Context Menu]] stays a
 * *presentation surface* over the Command registry - the same relationship the
 * [[Command Menu]] and [[Command Bar]] already have - and so a keybinding or a menu item can
 * reach them later without touching the Sidebar.
 *
 * Each takes a {@link ContextMenuTarget} as its argument, because a Context Menu acts on a
 * target rather than on whatever is focused.
 */

import { type NoticeAction, showNotice } from '#lib/activity/notices.js'
import {
    type ContextMenuTarget,
    type CommandRegistry,
    type ContributionRegistry,
    isBacklinkTarget,
    isDocumentTarget,
    isWikilinkTarget,
    registerContextMenuItem,
    type TabContextMenuTarget,
    type ViewFavouriteContextMenuTarget,
} from '#lib/surface/index.js'

import type { PaneSide } from '#lib/layout/index.js'
import type { ViewFavourites } from '#lib/layout/view-favourites.js'

import { type Favourite, sanitizeFavourite, type ViewFavourite } from '../favourite-entry'
import { addFavourite, isFavourite, moveFavourite, removeFavourite, restoreFavourite } from '../favourites'
import { isJournalConcept } from '../journal-concept'
import { copyFailureMessage, writeClipboardText } from './clipboard-text'

export const FAVOURITE_ADD = 'favourites.add'
export const FAVOURITE_REMOVE = 'favourites.remove'
export const FAVOURITE_MOVE = 'favourites.move'
/**
 * The notice an add or a remove posts, whichever surface it came from. Its own id, so a favourite
 * notice replaces the last one rather than piling up, and leaves the workspace's status line alone.
 */
export const FAVOURITES_NOTICE = 'favourites'
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
/**
 * Show a concept's tasks: the Tasks View's [[Name Filter]] set to the concept, its other filters
 * left as they are, and the View brought to the front. Beside `tasks.open` (Alt+T), which reveals
 * the View on whatever it is filtered to.
 */
export const TASKS_SHOW = 'tasks.show'
/** Bring a document's tab to the front and open [[Find and Replace]] in it (ADR 0153). */
export const DOCUMENT_FIND = 'document.findInTab'
/**
 * Open a wikilink's concept in the [[Pane]] to the right of the one the link is in, splitting one
 * off when there is none, and moving its tab there when it is open elsewhere (ADR 0155). On a
 * [[Backlink]], its document, at the reference's line.
 */
export const DOCUMENT_OPEN_TO_THE_RIGHT = 'document.openToTheRight'
/** {@link DOCUMENT_OPEN_TO_THE_RIGHT} into the Pane below, splitting one off downwards. */
export const DOCUMENT_OPEN_BELOW = 'document.openBelow'

/**
 * What an open beside acts on: a wikilink's concept, or a backlink's document and line, with the
 * panel to open beside. Null for any other target, and for a link with no panel to start from.
 */
function besideOf(arg: unknown): { concept: string; panelId: string; line?: number } | null {
    const target = arg as ContextMenuTarget | undefined
    if (!target) return null
    if (isWikilinkTarget(target)) return target.panelId ? { concept: target.concept, panelId: target.panelId } : null
    if (isBacklinkTarget(target)) return { concept: target.concept, panelId: target.panelId, line: target.line }
    return null
}

function conceptOf(arg: unknown): string {
    const target = arg as ContextMenuTarget | undefined
    if (!target) return ''
    // A document target, or a wikilink's concept (ADR 0065): Rename… and the favourite pair
    // (ADR 0158) act on either.
    return (isDocumentTarget(target) || isWikilinkTarget(target)) && typeof target.concept === 'string'
        ? target.concept
        : ''
}

/** `favourites.move`'s argument: where a favourite, a document or a View, should sit in the list, 0-based. */
export interface FavouriteMoveArg {
    favourite: Favourite
    toIndex: number
}

function moveArgOf(arg: unknown): FavouriteMoveArg | null {
    const move = arg as Partial<FavouriteMoveArg> | undefined
    if (!move || typeof move.toIndex !== 'number') return null
    const favourite = sanitizeFavourite(move.favourite)
    return favourite === null ? null : { favourite, toIndex: move.toIndex }
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
    /**
     * Filter the Tasks View to a concept and bring it to the front. The workspace owns the
     * filter (`task-filter-store.ts`) and the reveal; absent where there is no Tasks View.
     */
    showTasks?: (concept: string) => void
    /** Bring the document's tab to the front and open find in it; absent where there are no tabs. */
    findIn?: (concept: string) => void
    /**
     * Open a concept in the Pane to the right of, or below, the one holding `sourcePanelId` (ADR
     * 0155), at the 0-based body `line` when there is one. The workspace owns the Layout and the
     * focus that follows; absent where there is no Layout.
     */
    openBeside?: (concept: string, sourcePanelId: string, side: PaneSide, line?: number) => void
    /**
     * Whether the Layout can open beside the Pane holding `sourcePanelId`: it is a main-region
     * Pane and Panes show side by side, which a phone's do not. Absent ⇒ never.
     */
    canOpenBeside?: (sourcePanelId: string) => boolean
    /**
     * The name a [[Concept]] is known by: an [[Alias]]'s page, a pageless concept's display name.
     * The favourite rows act on this, so a link written through an alias favourites the page it
     * opens. Absent ⇒ every concept names itself (a harness with no index).
     */
    canonicalName?: (concept: string) => string
    /**
     * Which Views can be favourites, and their titles (ADR 0169): a Kanban board's or a Map View's
     * tab then offers the favourite pair too. Absent ⇒ only documents can be favourited.
     */
    viewFavourites?: Pick<ViewFavourites, 'favouriteOf' | 'describe'>
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

    /**
     * The favourite a favourite row acts on, or null for a target that is none. A document or a
     * link: its concept, by the name the graph knows it by - a tab already carries that name, a link
     * carries what its author typed, which may be an alias. The tab of a View that can be a
     * favourite: that View (ADR 0169). A View favourite's Sidebar row: its entry.
     */
    const favouriteOf = (arg: unknown): Favourite | null => {
        const target = arg as ContextMenuTarget | undefined
        if (target?.kind === 'view-favourite' || target?.kind === 'tab') return viewFavouriteOf(target)
        const concept = conceptOf(target)
        return concept === '' ? null : (deps.canonicalName?.(concept) ?? concept)
    }

    /** A View favourite's row names its entry; a tab, the View it shows when that View can be one. */
    const viewFavouriteOf = (target: TabContextMenuTarget | ViewFavouriteContextMenuTarget): ViewFavourite | null => {
        if (target.kind === 'view-favourite') return target.favourite
        return target.view ? (deps.viewFavourites?.favouriteOf(target.view, target.title) ?? null) : null
    }

    /** What a notice calls a favourite: a document by its name, a View by its tab's title. */
    const nameOf = (favourite: Favourite): string =>
        typeof favourite === 'string' ? favourite : (deps.viewFavourites?.describe(favourite).title ?? favourite.kind)

    const announce = (text: string, actions?: NoticeAction[]) =>
        showNotice({ id: FAVOURITES_NOTICE, tone: 'info', text, actions })

    // Every add and remove says so in a notice, whichever surface it came from (a tab, a link,
    // a Sidebar row): from a link or on a phone the Favourites list is usually out of sight, and
    // one behaviour everywhere reads better than a notice that comes and goes with the surface.
    const add = async (favourite: Favourite | null) => {
        if (favourite === null || isFavourite(favourite)) return
        await addFavourite(favourite)
        announce(`Added "${nameOf(favourite)}" to favourites`)
    }

    // A remove offers Undo, which puts the favourite back where it stood: the list is ordered by
    // hand, and adding it again would land it at the bottom. A refused Undo leaves the card as it
    // was, so its Undo can be tried again.
    const remove = async (favourite: Favourite | null) => {
        if (favourite === null) return
        const removed = await removeFavourite(favourite)
        if (!removed) return
        const name = nameOf(removed.favourite)
        const undo = async () => {
            try {
                await restoreFavourite(removed.favourite, removed.index)
            } catch (err) {
                deps.onError?.((err as Error).message)
                return
            }
            announce(`"${name}" is back in favourites`)
        }
        announce(`Removed "${name}" from favourites`, [{ id: 'favourite-undo', label: 'Undo', primary: true, run: undo }])
    }

    disposers.push(
        commands.register(FAVOURITE_ADD, (arg) => guard(add(favouriteOf(arg)))),
        commands.register(FAVOURITE_REMOVE, (arg) => guard(remove(favouriteOf(arg)))),
        // Not a Context Menu row: this is how the Sidebar's drag handle and its arrow keys write
        // the order, so a refused write reaches the user the same way a refused add does.
        commands.register(FAVOURITE_MOVE, (arg) => {
            const move = moveArgOf(arg)
            return move ? guard(moveFavourite(move.favourite, move.toIndex)) : undefined
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
        commands.register(TASKS_SHOW, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.showTasks?.(concept)
        }),
        commands.register(DOCUMENT_FIND, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') deps.findIn?.(concept)
        }),
        ...(['right', 'below'] as const).map((side) =>
            commands.register(side === 'right' ? DOCUMENT_OPEN_TO_THE_RIGHT : DOCUMENT_OPEN_BELOW, (arg) => {
                const beside = besideOf(arg)
                if (beside) deps.openBeside?.(beside.concept, beside.panelId, side, beside.line)
            }),
        ),
    )

    /** Whether the open-beside pair applies: a link or a backlink from a Pane the Layout can open beside. */
    const canOpenBesideFrom = (target: ContextMenuTarget): boolean => {
        const beside = besideOf(target)
        return beside !== null && deps.openBeside !== undefined && (deps.canOpenBeside?.(beside.panelId) ?? false)
    }

    disposers.push(
        registerContextMenuItem(contributions, {
            id: DOCUMENT_OPEN_TO_THE_RIGHT,
            label: 'Open in pane to the right',
            command: DOCUMENT_OPEN_TO_THE_RIGHT,
            icon: 'pane-right',
            // First on a link: following it is what a link is for. On a link or a backlink only,
            // from the Pane it sits in, and not offered where no Pane can be beside that one (the
            // phone, a Sidebar): there a click on the link is all there is.
            order: 1,
            when: canOpenBesideFrom,
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_OPEN_BELOW,
            label: 'Open in pane below',
            command: DOCUMENT_OPEN_BELOW,
            icon: 'pane-below',
            // Second, beside its pair, on the same targets.
            order: 2,
            when: canOpenBesideFrom,
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_FIND,
            label: 'Find in document',
            command: DOCUMENT_FIND,
            icon: 'search',
            // First: it acts on the tab's own text, before the rows about the concept. On a tab
            // only, since the find box belongs to the tab's View (ADR 0153).
            order: 4,
            when: (target) => target.kind === 'document-tab' && deps.findIn !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: BACKLINKS_SHOW,
            label: 'Show Backlinks',
            command: BACKLINKS_SHOW,
            // The Backlinks View's own icon, on its tab too.
            icon: 'backlinks',
            // First of the rows that show something about a concept and change nothing: Show
            // Backlinks (5), the extensions' Open Kanban Board (6), Show in Graph View (7) and
            // Open Map View (8), then Show Tasks (9). On a tab each acts on the tab's document
            // whether or not that tab is in front; on a wikilink, on the concept the link names -
            // the innermost link under the pointer, as a click resolves it. The Sidebar rows
            // (Favourites, Recents, All Documents) could carry them too, but have not been asked
            // for.
            order: 5,
            when: (target) =>
                (target.kind === 'document-tab' || isWikilinkTarget(target)) && deps.showBacklinks !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: TASKS_SHOW,
            label: 'Show Tasks',
            command: TASKS_SHOW,
            // The checkbox a task is drawn with in the editor.
            icon: 'task',
            // Last of the rows that show something about a concept (see Show Backlinks).
            order: 9,
            when: (target) =>
                (target.kind === 'document-tab' || isWikilinkTarget(target)) && deps.showTasks !== undefined,
        }),
        registerContextMenuItem(contributions, {
            id: FAVOURITE_ADD,
            label: 'Add to favourites',
            command: FAVOURITE_ADD,
            // After the rows that show something, before Rename…, on a link as on a tab. On every
            // link (ADR 0158): one to a concept with no page yet as well, whose favourite opens it
            // as a Draft tab's does, and a journal day's. On the tab of a View that can be a
            // favourite too, a Kanban board's or a Map View's (ADR 0169).
            order: 10,
            when: (target) => {
                const favourite = favouriteOf(target)
                return favourite !== null && !isFavourite(favourite)
            },
        }),
        registerContextMenuItem(contributions, {
            id: FAVOURITE_REMOVE,
            label: 'Remove from favourites',
            command: FAVOURITE_REMOVE,
            order: 10,
            when: (target) => {
                const favourite = favouriteOf(target)
                return favourite !== null && isFavourite(favourite)
            },
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
            danger: true,
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

