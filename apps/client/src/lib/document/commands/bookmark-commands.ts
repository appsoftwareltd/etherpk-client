/**
 * The [[Bookmark]] Commands and their Context Menu and Command Menu rows (ADR 0159, ADR 0160).
 *
 * Every row says what it will do: "Bookmark line" and "Remove bookmark" are two rows with
 * complementary `when`s rather than one toggle row, as the favourite pair is. Ctrl+Alt+K and the
 * Command Menu run the one toggle Command at the caret.
 *
 * Every removal goes through `removeBookmarksWithUndo`, so each one offers Undo and none asks first.
 */

import type { EditorView } from '@codemirror/view'

import {
    type CommandRegistry,
    type ContributionRegistry,
    type ContextMenuTarget,
    type EditorLine,
    editorLineOf,
    isBookmarkGroupTarget,
    isBookmarkTarget,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { bookmarksIn, getBookmarks } from '../bookmarks/bookmarks'
import { bookmarkCount, removeBookmarksWithUndo } from '../bookmarks/remove-with-undo'
import { requestBookmarkLabelEdit, requestBookmarkReveal } from '../bookmarks/status'
import { bookmarkOnLine, bookmarkedLines } from '../view/augmentations/bookmark-marks'
import { bookmarkEditorFor, toggleBookmarkAtCaret, toggleBookmarkAtLine } from '../view/augmentations/bookmarks'

export const BOOKMARK_TOGGLE = 'bookmarks.toggle'
export const BOOKMARK_EDIT_LABEL = 'bookmarks.editLabel'
export const BOOKMARK_REMOVE = 'bookmarks.remove'
export const BOOKMARK_REMOVE_GROUP = 'bookmarks.removeGroup'
export const BOOKMARK_REMOVE_ALL = 'bookmarks.removeAll'
export const BOOKMARK_OPEN = 'bookmarks.open'

export interface BookmarkCommandDeps {
    /**
     * Open the bookmark's document showing `line`, 0-based from the start of the file: held over the
     * Reading Position the activation would otherwise restore.
     */
    openDocumentAtLine(concept: string, line: number): void
    /** Bring the graph Sidebar into view, for a label edit started from an editor. */
    revealSidebar(): void
    onError?(text: string): void
}

/** The editor a line target names, or null when it has closed since the menu opened. */
function editorOf(line: EditorLine): EditorView | null {
    return bookmarkEditorFor(line.concept, line.panelId)
}

/** The bookmark on a line target's line, or null. */
function bookmarkOnTargetLine(line: EditorLine): string | null {
    const view = editorOf(line)
    return view && line.line <= view.state.doc.lines ? bookmarkOnLine(view.state, line.line) : null
}

const isLineTarget = (target: ContextMenuTarget) => editorLineOf(target) !== null

/** The bookmark id a target stands for: a Sidebar row's, or the one on an editor line. */
function bookmarkIdOf(arg: unknown): string | null {
    const target = arg as ContextMenuTarget | undefined
    if (!target || typeof target !== 'object') return null
    if (isBookmarkTarget(target)) return target.id
    const line = editorLineOf(target)
    return line ? bookmarkOnTargetLine(line) : null
}

export function registerBookmarkCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: BookmarkCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    /** A refused write reaches the person, whichever surface asked for it. */
    const guarded = (work: () => Promise<unknown>) => () =>
        work().then(
            () => undefined,
            (err: unknown) => deps.onError?.(err instanceof Error ? err.message : String(err)),
        )

    disposers.push(
        // `toggleBookmarkAtLine` says itself why a line cannot be bookmarked, and reports a refused
        // write; nothing is left for this handler to catch.
        commands.register(BOOKMARK_TOGGLE, (arg) => {
            const line = arg && typeof arg === 'object' ? editorLineOf(arg as ContextMenuTarget) : null
            const view = line ? editorOf(line) : getActiveEditorView()
            if (!view) return
            return line ? toggleBookmarkAtLine(view, line.line) : toggleBookmarkAtCaret(view)
        }),
        commands.register(BOOKMARK_EDIT_LABEL, (arg) => {
            const id = bookmarkIdOf(arg)
            if (id === null) return
            // From an editor the Sidebar may be out of sight; from its own row it is already there.
            if (!isBookmarkTarget(arg as ContextMenuTarget)) deps.revealSidebar()
            requestBookmarkLabelEdit(id)
        }),
        commands.register(BOOKMARK_REMOVE, (arg) => {
            const id = bookmarkIdOf(arg)
            if (id !== null) return guarded(() => removeBookmarksWithUndo([id], () => 'Bookmark removed'))()
        }),
        commands.register(BOOKMARK_REMOVE_GROUP, (arg) => {
            const target = arg as ContextMenuTarget | undefined
            if (!target || !isBookmarkGroupTarget(target)) return
            const ids = bookmarksIn(target.concept).map((b) => b.id)
            return guarded(() =>
                removeBookmarksWithUndo(ids, (n) => `Removed ${bookmarkCount(n)} from "${target.concept}"`),
            )()
        }),
        commands.register(
            BOOKMARK_REMOVE_ALL,
            guarded(() => removeBookmarksWithUndo(getBookmarks().map((b) => b.id), (n) => `Removed ${bookmarkCount(n)}`)),
        ),
        commands.register(BOOKMARK_OPEN, (arg) => {
            const id = bookmarkIdOf(arg)
            const bookmark = getBookmarks().find((b) => b.id === id)
            if (!bookmark) return
            // Asked first, so the editor that opens (or the one already open) takes it. The open goes
            // through the held reveal, so activating the tab does not restore its Reading Position
            // over the line: the line an open editor has now, or the stored one, which the field's
            // own placing then refines.
            requestBookmarkReveal(bookmark.id, bookmark.concept)
            const view = bookmarkEditorFor(bookmark.concept)
            const marked = view ? bookmarkedLines(view.state).find((m) => m.id === bookmark.id) : undefined
            deps.openDocumentAtLine(bookmark.concept, marked ? marked.line - 1 : bookmark.line)
        }),
    )

    // ── Context Menu rows ────────────────────────────────────────────────────
    // On a line target these lead the menu. On a link or a misspelt word they follow that thing's
    // own rows, after a separator, so the line rows are there wherever EtherPK's menu opens.
    const onBookmarkedLine = (target: ContextMenuTarget) => {
        const line = editorLineOf(target)
        return line !== null && bookmarkOnTargetLine(line) !== null
    }
    const item = (descriptor: Parameters<typeof registerContextMenuItem>[1]) =>
        disposers.push(registerContextMenuItem(contributions, descriptor))

    item({
        id: `${BOOKMARK_TOGGLE}.add`,
        label: 'Bookmark line',
        command: BOOKMARK_TOGGLE,
        icon: 'bookmark',
        order: 90,
        separatorBefore: true,
        when: (target) => isLineTarget(target) && !onBookmarkedLine(target),
    })
    item({
        id: `${BOOKMARK_TOGGLE}.remove`,
        label: 'Remove bookmark',
        command: BOOKMARK_TOGGLE,
        icon: 'bookmark',
        order: 90,
        separatorBefore: true,
        when: (target) => isLineTarget(target) && onBookmarkedLine(target),
    })
    item({
        id: BOOKMARK_EDIT_LABEL,
        label: 'Edit label…',
        command: BOOKMARK_EDIT_LABEL,
        icon: 'rename',
        order: 91,
        when: (target) => isBookmarkTarget(target) || onBookmarkedLine(target),
    })
    item({
        id: BOOKMARK_REMOVE,
        label: 'Remove bookmark',
        command: BOOKMARK_REMOVE,
        icon: 'trash',
        order: 92,
        when: (target) => isBookmarkTarget(target),
    })
    item({
        id: BOOKMARK_REMOVE_GROUP,
        label: 'Remove these bookmarks',
        command: BOOKMARK_REMOVE_GROUP,
        icon: 'trash',
        order: 92,
        when: (target) => isBookmarkGroupTarget(target),
    })

    disposers.push(
        registerCommandMenuItem(contributions, {
            id: BOOKMARK_TOGGLE,
            title: 'Toggle bookmark',
            detail: 'Bookmark this line, or remove its bookmark',
            icon: 'bookmark',
            group: 'Editor',
            order: 152,
            keywords: ['bookmark', 'mark', 'line'],
            command: BOOKMARK_TOGGLE,
        }),
    )

    return () => {
        for (const dispose of disposers.splice(0)) dispose()
    }
}
