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
    /** The caret's line is a [[Task]] outside a [[Protected Document]] (gates Copy task reference). Absent reads as false. */
    taskOnLine?: boolean
    /** The document is a [[Protected Document]], locked or not (hides `/map`: no map is drawn in one, ADR 0118). Absent reads as false. */
    protectedDocument?: boolean
    /**
     * The concepts a View about one concept can be opened for from the caret, nearest first: the
     * caret line's links, the links above it in the outline, the document's own concept, then the
     * scopes in its name (`caret-concepts.ts`). Names are as written, an alias as the alias.
     * Worked out only when a row reads it. Absent reads as none.
     */
    readonly conceptsAtCaret?: readonly string[]
}

/** One Command Menu row. `command` is the Command id selecting the row executes. */
export interface CommandMenuItem {
    /** Stable, namespaced id (e.g. `date.today`, `table.addRow`). */
    id: string
    /** Shown in the menu and matched against the typed query. */
    title: string
    /**
     * Secondary, right-aligned hint (e.g. `Insert [[2026-06-25]]`), or a function that works it out
     * from the editor the menu opened in each time it opens (`/kanban`'s "For Garden").
     */
    detail?: string | ((ctx: CommandMenuContext) => string | undefined)
    /** Icon name resolved to an SVG by the popover (unknown ⇒ a default glyph). */
    icon?: string
    /** Section label (e.g. `Date`, `Table`). */
    group?: string
    /**
     * Sort key for a bare `/`: lower lists earlier, and equal values keep registration order. A row
     * without one lists after every row that has one. The rows come from several modules registered
     * in the workspace's order, so each carries its place in the menu itself; the whole first-party
     * order is written down in `document/commands/command-menu-order.test.ts`.
     */
    order?: number
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

/** The sort key of a row: its `order`, or after every row that has one. */
const menuOrder = (item: CommandMenuItem) => item.order ?? Number.MAX_SAFE_INTEGER

/** Every registered item in menu order (`order`, then registration order), applicable or not. */
export function commandMenuItemsInOrder(registry: ContributionRegistry): CommandMenuItem[] {
    return registry
        .list(COMMAND_MENU_KIND)
        .map((e) => e.value as CommandMenuItem)
        .sort((a, b) => menuOrder(a) - menuOrder(b))
}

/**
 * A row's help text in `ctx`: the row's own, or what its function works out. A function that throws
 * gives none, so one row never takes the menu down.
 */
export function commandMenuDetail(item: CommandMenuItem, ctx: CommandMenuContext): string | undefined {
    if (typeof item.detail !== 'function') return item.detail
    try {
        return item.detail(ctx)
    } catch {
        return undefined
    }
}

/** Every registered item in menu order, filtered to those applicable in `ctx`. */
export function listCommandMenuItems(registry: ContributionRegistry, ctx: CommandMenuContext): CommandMenuItem[] {
    return commandMenuItemsInOrder(registry).filter((item) => !item.when || item.when(ctx))
}
