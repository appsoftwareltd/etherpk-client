/**
 * The **menu-item Contribution Point** that feeds the **Command Menu** (CONTEXT.md →
 * **Command Menu**; Dual Mode Editor.md → *Command Menu (slash commands)*). Each
 * descriptor is a presentation row that resolves to one **Command**: selecting it runs
 * `command` through the Command registry. The descriptor — not the Command — carries the
 * presentation (`title`/`icon`/`detail`/`group`) and the `when` visibility predicate, so
 * the Command registry stays a pure id→handler map and the same action is reachable later
 * from a keybinding or palette.
 *
 * This is the generic Contribution registry's second kind (the `'view'` kind being the
 * first) — see docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md.
 */

import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Command Menu items are registered. */
export const COMMAND_MENU_KIND = 'command-menu'

/**
 * The editor context a `when` predicate reads to decide whether an item is applicable.
 * Computed by the menu from the live editor on each open; kept minimal and additive.
 */
export interface CommandMenuContext {
    /** The caret sits inside a GFM table (gates the table-mutation items). */
    inTable: boolean
    /** A table can be inserted at the caret: not in fenced code, frontmatter, or a table (gates Table). */
    tableInsertable: boolean
    /** The body will take an edit - false on a locked [[Protected Document]] (hides every editing item). */
    bodyWritable: boolean
    /** The caret's line holds a [[File Link]] (gates Copy file path; `/` only opens at a word boundary, so "inside" would be unreachable). Absent reads as false. */
    fileLinkOnLine?: boolean
}

/** One Command Menu row. `command` is the Command id selecting the row executes. */
export interface CommandMenuItem {
    /** Stable, namespaced id (e.g. `date.today`, `table.addRow`). */
    id: string
    /** Shown in the menu and matched against the typed query. */
    title: string
    /** Secondary, right-aligned hint (e.g. `Insert [[2026-06-25]]`). */
    detail?: string
    /** Icon name resolved to an SVG by the popover (unknown ⇒ a default glyph). */
    icon?: string
    /** Section / ordering label (e.g. `Date`, `Table`). */
    group?: string
    /** Extra fuzzy-match terms beyond the title (e.g. `['calendar', 'date']`). */
    keywords?: string[]
    /** Applicability predicate; absent ⇒ always shown. */
    when?: (ctx: CommandMenuContext) => boolean
    /** The Command id to execute on accept. */
    command: string
    /** Optional argument forwarded to the Command (merged with the editor context). */
    args?: unknown
}

/** Register a Command Menu item; returns an unregister fn. */
export function registerCommandMenuItem(registry: ContributionRegistry, item: CommandMenuItem): () => void {
    return registry.register(COMMAND_MENU_KIND, item.id, item)
}

/** Every registered item, in registration order, filtered to those applicable in `ctx`. */
export function listCommandMenuItems(registry: ContributionRegistry, ctx: CommandMenuContext): CommandMenuItem[] {
    return registry
        .list(COMMAND_MENU_KIND)
        .map((e) => e.value as CommandMenuItem)
        .filter((item) => !item.when || item.when(ctx))
}
