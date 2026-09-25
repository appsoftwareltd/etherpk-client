/**
 * Every keyboard shortcut the workspace offers, in one place, with the words the user sees.
 *
 * Two layers, two homes (Dual Mode Editor.md → Keyboard scheme):
 *
 * - `APP_KEYBINDINGS` are the app-level chords. This list IS the binding: `GraphWorkspace`
 *   hands it to `attachKeybindings`, and the Keyboard Shortcuts dialog reads the same rows, so
 *   the dialog cannot drift from what the keys do. Add a chord here and it is both bound and
 *   documented.
 * - `EDITOR_SHORTCUTS` are the CodeMirror-native block ops. Their bindings live in
 *   `document/view/outliner-keymap.ts` (and the popover keymaps beside it) and are executable
 *   in `outliner-keymap.rules.test.ts`; the rows here are the reference card for them, kept
 *   deliberately to what a user would look up rather than every rule the keymap holds.
 */

import type { Keybinding } from '$lib/surface'

export interface AppKeybinding extends Keybinding {
    /** What the chord does, as the dialog says it. */
    label: string
    /** The section of the Keyboard Shortcuts card the row sits under. */
    group: AppShortcutGroup
}

/** The card's app-level sections, in the order they are shown. */
export const APP_SHORTCUT_GROUPS = ['Go to', 'Sidebars', 'Editor', 'Publish', 'Help'] as const
export type AppShortcutGroup = (typeof APP_SHORTCUT_GROUPS)[number]

export interface EditorShortcut {
    /** Chord spec in the app's own `Mod+Shift+K` spelling (rendered by `formatChord`). */
    key: string
    label: string
}

export interface ShortcutGroup {
    title: string
    /** An optional line under the title: where these keys apply. */
    note?: string
    shortcuts: EditorShortcut[]
}

export const APP_KEYBINDINGS: AppKeybinding[] = [
    // ── Go to ─────────────────────────────────────────────────────────────────────────────
    { key: 'Alt+J', command: 'document.openTodayJournal', label: "Today's journal entry", group: 'Go to' },
    { key: 'Alt+F', command: 'search.open', label: 'Search the graph', group: 'Go to' },
    // Deliberately off the app's Alt-only convention. Mod+K is what everyone reaches for first
    // in a modern editor, and one extra binding on the same command is a cheap way to be right
    // about that.
    { key: 'Mod+K', command: 'search.open', label: 'Search the graph', group: 'Go to' },
    // ── Sidebars ──────────────────────────────────────────────────────────────────────────
    // One letter per Sidebar (L, R) to toggle it, and one per resident (G, N, B, T) to get to it:
    // a reveal ends with the View in front of an expanded Sidebar, a toggle collapses as often as
    // it expands, and each brings a closed resident back (workspace/residents.ts, 2026-09-18).
    { key: 'Alt+G', command: 'graph.open', label: 'Graph', group: 'Sidebars' },
    { key: 'Alt+N', command: 'quickNotes.open', label: 'Quick notes, ready to type', group: 'Sidebars' },
    { key: 'Alt+B', command: 'backlinks.open', label: 'Backlinks', group: 'Sidebars' },
    { key: 'Alt+T', command: 'tasks.open', label: 'Tasks', group: 'Sidebars' },
    { key: 'Alt+L', command: 'layout.toggleSidebar', label: 'Show or hide the left sidebar', group: 'Sidebars' },
    { key: 'Alt+R', command: 'layout.toggleBacklinks', label: 'Show or hide the right sidebar', group: 'Sidebars' },
    // ── Editor ────────────────────────────────────────────────────────────────────────────
    // Spell Check is a device preference, so the chord works with no editor focused. Alt+S was
    // the left sidebar's toggle until 2026-09-18 (Alt+L now); reused for spell check on 2026-09-23.
    { key: 'Alt+S', command: 'editor.toggleSpellCheck', label: 'Turn spell check on or off (this device)', group: 'Editor' },
    // ── Publish ───────────────────────────────────────────────────────────────────────────
    // After an edit: P opens the publication's settings (the Publish tab of Settings), Shift+P
    // publishes the last publication published from this device again, to its folder, with no
    // dialog in between; it opens the tab instead when it cannot tell which or where.
    { key: 'Alt+P', command: 'publish.settings', label: 'Publish settings', group: 'Publish' },
    { key: 'Alt+Shift+P', command: 'publish.run', label: 'Publish again (the last publication, to its folder)', group: 'Publish' },
    // ── Help ──────────────────────────────────────────────────────────────────────────────
    // The same exception as Mod+K, for the same reason: `Mod+/` is where a keyboard user looks
    // for the list of keys in most tools, and this list is only useful once it has been found.
    { key: 'Mod+/', command: 'help.openShortcuts', label: 'This card', group: 'Help' },
]

export const EDITOR_SHORTCUTS: ShortcutGroup[] = [
    {
        title: 'Outliner blocks',
        note: 'On a bullet or task line. A block moves with its children.',
        shortcuts: [
            { key: 'Tab', label: 'Indent the block (a prose line becomes a bullet)' },
            { key: 'Shift+Tab', label: 'Outdent the block (past the root it becomes prose)' },
            { key: 'Enter', label: 'New sibling block' },
            { key: 'Shift+Enter', label: 'Line break within the block' },
            { key: 'Mod+Enter', label: 'Leave the outliner: a prose line after the tree' },
            { key: 'Alt+ArrowUp', label: 'Move the block up' },
            { key: 'Alt+ArrowDown', label: 'Move the block down' },
            { key: 'Mod+.', label: 'Fold or unfold the block' },
            { key: 'Mod+Shift+Enter', label: 'Cycle task state: plain → open → done (prose: make the line a task)' },
        ],
    },
    {
        title: 'Code blocks',
        shortcuts: [
            { key: 'Enter', label: 'New line inside the block' },
            { key: 'Tab', label: 'Indent the code' },
            { key: 'Shift+Tab', label: 'Outdent the code' },
            { key: 'Mod+Enter', label: 'Leave the block' },
        ],
    },
    {
        title: 'While typing',
        shortcuts: [
            { key: '/', label: 'Open the command menu' },
            { key: '[[', label: 'Link to a document' },
            { key: '#', label: 'Add a task tag (on a task line)' },
            { key: '* _ ~ = [ ( `', label: 'Over selected text: wrap it (press again to add a layer, e.g. ** or [[)' },
            { key: 'Mod+B', label: 'Bold the selection, or unbold it' },
            { key: 'Mod+I', label: 'Italicise the selection, or unitalicise it' },
            { key: 'Mod+Shift+H', label: 'Highlight the selection, or clear the highlight' },
            { key: '```', label: 'Then Enter: complete a code fence' },
            { key: 'Mod+Z', label: 'Undo' },
            { key: 'Mod+Shift+Z', label: 'Redo' },
            { key: 'Escape', label: 'Leave the editor (then Tab moves focus on)' },
        ],
    },
]
