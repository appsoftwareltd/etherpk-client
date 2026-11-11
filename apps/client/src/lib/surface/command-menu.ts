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
    /** The caret's line is a [[Task]] outside a [[Protected Document]] (gates Copy agent instruction). Absent reads as false. */
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
    /**
     * The editor shows one part of a document rather than the whole: the [[Task Editor]]'s
     * description and comments (ADR 0170). Only rows that act on the text are offered there
     * ({@link CommandMenuItem.actsOnText}). Absent reads as false.
     */
    partOfDocument?: boolean
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
    /**
     * The heading the row is listed under: one of {@link COMMAND_MENU_GROUPS}. A row that names none,
     * or a heading the menu does not have (an extension written before the headings), is placed by
     * {@link commandMenuGroup}. A string rather than the union, because an extension's row arrives
     * with whatever its author wrote.
     */
    group?: string
    /**
     * Sort key within the row's group for a bare `/`: lower lists earlier, and equal values keep
     * registration order. A row without one lists after every row of its group that has one. The
     * rows come from several modules registered in the workspace's order, so each carries its place
     * in the menu itself; the whole first-party order is written down in
     * `document/commands/command-menu-order.test.ts`.
     */
    order?: number
    /** Extra fuzzy-match terms beyond the title (e.g. `['calendar', 'date']`). */
    keywords?: string[]
    /** Applicability predicate; absent ⇒ always shown. */
    when?: (ctx: CommandMenuContext) => boolean
    /**
     * The row acts on the text at the caret and nothing else: it inserts or formats text, edits a
     * table, or copies what the caret's line holds. Only such rows are offered in an editor that
     * shows part of a document ({@link CommandMenuContext.partOfDocument}), where a row acting on the
     * tab, the document as a whole, a View or the graph would act on whatever is behind the dialog.
     * Absent reads as false, so a row is left out there until it says otherwise.
     */
    actsOnText?: boolean
    /** The Command id to execute on accept. */
    command: string
    /** Optional argument forwarded to the Command (merged with the editor context). */
    args?: unknown
}

/** Register a Command Menu item; returns an unregister fn. */
export function registerCommandMenuItem(registry: ContributionRegistry, item: CommandMenuItem): () => void {
    return registry.register(COMMAND_MENU_KIND, item.id, item)
}

/**
 * The menu's headings, in the order it lists them: what puts something in the document, then what
 * goes somewhere or finds something, then what changes how EtherPK behaves.
 */
export const COMMAND_MENU_GROUPS = ['Insert', 'Go to', 'Settings'] as const

/** One of the menu's headings. */
export type CommandMenuGroup = (typeof COMMAND_MENU_GROUPS)[number]

/**
 * The heading a row is listed under: the one it names, or, for a row that names none or one the
 * menu does not have, Insert when it acts on the text at the caret and Go to otherwise. The rows
 * extensions register without a heading open a View or a panel, or put a block in the text, so the
 * two cover them; no row becomes a setting without saying so.
 */
export function commandMenuGroup(item: Pick<CommandMenuItem, 'group' | 'actsOnText'>): CommandMenuGroup {
    const named = COMMAND_MENU_GROUPS.find((group) => group === item.group)
    return named ?? (item.actsOnText ? 'Insert' : 'Go to')
}

/** Where a row's group comes in the menu: lower lists earlier. */
export const commandMenuGroupRank = (item: Pick<CommandMenuItem, 'group' | 'actsOnText'>): number => COMMAND_MENU_GROUPS.indexOf(commandMenuGroup(item))

/** The sort key of a row within its group: its `order`, or after every row that has one. */
const menuOrder = (item: CommandMenuItem) => item.order ?? Number.MAX_SAFE_INTEGER

/** Every registered item in menu order (group, then `order`, then registration order), applicable or not. */
export function commandMenuItemsInOrder(registry: ContributionRegistry): CommandMenuItem[] {
    return registry
        .list(COMMAND_MENU_KIND)
        .map((e) => e.value as CommandMenuItem)
        .sort((a, b) => commandMenuGroupRank(a) - commandMenuGroupRank(b) || menuOrder(a) - menuOrder(b))
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
    return commandMenuItemsInOrder(registry).filter((item) => (!ctx.partOfDocument || item.actsOnText === true) && (!item.when || item.when(ctx)))
}
