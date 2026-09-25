/**
 * The **command-bar Contribution Point** that feeds the **Command Bar** (CONTEXT.md →
 * **Command Bar**) — the mobile-only row of buttons fixed to the bottom of the viewport,
 * each invoking a [[Command]] on the active editor. Like the menu-item kind that feeds the
 * Command Menu, each descriptor is a presentation row that resolves to one **Command**:
 * tapping it runs `command` through the Command registry. The descriptor carries the
 * presentation (`icon`/`label`/`order`) and an optional `when` predicate.
 *
 * This is the generic Contribution registry's **third kind** (after `'view'` and
 * `'command-menu'`) — the generalisation in
 * docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md absorbing
 * a new kind at no cost, exactly as designed.
 */

import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Command Bar buttons are registered. */
export const COMMAND_BAR_KIND = 'command-bar'

/** One Command Bar button. `command` is the Command id tapping the button executes. */
export interface CommandBarItem {
    /** Stable, namespaced id (e.g. `editor.indent`). */
    id: string
    /** Icon name resolved to an SVG by the bar (unknown ⇒ a default glyph). */
    icon: string
    /** Accessible label / tooltip (no visible text — the bar is icon-only). */
    label: string
    /** Sort key; lower sorts earlier. Equal values keep registration order. */
    order?: number
    /** Which side of the bar the button sits on. `'start'` (default) scrolls; `'end'` is pinned. */
    align?: 'start' | 'end'
    /** Disabled (shown greyed) when the caret is not in an outliner block. */
    outlinerOnly?: boolean
    /**
     * Disabled when the document's body will not take an edit - a locked [[Protected Document]].
     * Every button whose Command writes to the body carries it; the Command itself refuses on
     * the same predicate, so the greyed button and the no-op agree.
     */
    writableOnly?: boolean
    /**
     * Disabled only where a line cannot be converted: headings, fenced code and frontmatter. Prose
     * counts (the button converts it), bullets count. The indent and task buttons use this gate.
     */
    convertibleOnly?: boolean
    /**
     * Disabled when the task toggle has nothing to do — a wider gate than `outlinerOnly`:
     * prose counts (the toggle makes the line a task), headings / code / frontmatter do not.
     */
    taskToggleOnly?: boolean
    /** Disabled where no table can be inserted: fenced code, frontmatter, and inside a table. */
    tableInsertOnly?: boolean
    /** Disabled unless the caret is on a table's body row (the header and separator cannot be removed). */
    tableRowOnly?: boolean
    /** Disabled on a single-column table (its last column cannot be removed). */
    tableMultiColumnOnly?: boolean
    /** Disabled while the active editor's history has nothing to undo. */
    undoOnly?: boolean
    /** Disabled while the active editor's history has nothing to redo. */
    redoOnly?: boolean
    /**
     * A **Contextual Group** (CONTEXT.md → Command Bar): the button is present only while the
     * caret is on the thing the group's Commands act on, and absent otherwise - not greyed, unlike
     * the fixed buttons - because a group that is dead almost all of the time would crowd the
     * strip. `'table'`: shown while the caret is in a table. `'spelling'`: while the caret is in a
     * word Spell Check has underlined.
     */
    contextualGroup?: 'table' | 'spelling'
    /** The Command id to execute on tap. */
    command: string
    /** Optional argument forwarded to the Command. */
    args?: unknown
    /** Applicability predicate; absent ⇒ always shown. */
    when?: () => boolean
}

/** Register a Command Bar button; returns an unregister fn. */
export function registerCommandBarItem(registry: ContributionRegistry, item: CommandBarItem): () => void {
    return registry.register(COMMAND_BAR_KIND, item.id, item)
}

/** Every applicable button, ordered by `order` then registration order. */
export function listCommandBarItems(registry: ContributionRegistry): CommandBarItem[] {
    return registry
        .list(COMMAND_BAR_KIND)
        .map((e) => e.value as CommandBarItem)
        .filter((item) => !item.when || item.when())
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
