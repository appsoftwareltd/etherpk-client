/**
 * The **context-menu Contribution Point** that feeds the [[Context Menu]] (CONTEXT.md) — the
 * menu raised by right-click or long-press on a specific thing. Like the menu-item kind that
 * feeds the [[Command Menu]] and the command-bar kind that feeds the [[Command Bar]], each
 * descriptor is a presentation row resolving to one [[Command]]; this is a presentation
 * surface, not a new kind of command.
 *
 * The registry's **fourth kind**, absorbed at no cost exactly as
 * docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md intended.
 *
 * What sets it apart from the other two surfaces: a Context Menu always acts on a **target**
 * rather than on whatever is focused. The target travels to the Command as its argument
 * (`execute(id, target)`), and `when` receives it so a row can decide whether it applies —
 * which is how one registration provides both "Add to favourites" and "Remove from
 * favourites" without two near-identical entries fighting over the same slot.
 */

import type { ContributionRegistry } from './contribution-registry'

/** The point kind under which Context Menu rows are registered. */
export const CONTEXT_MENU_KIND = 'context-menu'

/**
 * What a Context Menu was raised on. `kind` lets a row apply to some surfaces and not
 * others — a document tab and a Favourites row are both documents, but only the latter
 * offers "Remove from favourites" as its primary action.
 *
 * A union rather than one shape because the menu now acts on two genuinely different things.
 * A row declares which by narrowing on `kind` in its `when`; {@link isDocumentTarget} and
 * {@link isAssetTarget} are the narrowings, so no row has to know the whole union.
 */
export type ContextMenuTarget =
    | DocumentContextMenuTarget
    | AssetContextMenuTarget
    | TabContextMenuTarget
    | WikilinkContextMenuTarget
    | MisspellingContextMenuTarget

/**
 * A [[Wikilink]] someone right-clicked or long-pressed in an editor (ADR 0065). Deliberately
 * not a document target: a link names a [[Concept]] that may have no page, and the document
 * rows (favourite, delete) act on a document. Rename… is what applies, page or pageless.
 */
export interface WikilinkContextMenuTarget {
    kind: 'wikilink'
    /** The innermost link under the pointer, as a click resolves it. */
    concept: string
    /** The editor's panel, so a row can act in the right Pane. */
    panelId?: string
}

/**
 * A word [[Spell Check]] underlined, right-clicked or reached with Shift+F10 in an editor. It
 * carries its suggestions, fetched before the menu opened, so each suggestion row is a label and
 * nothing more; and its range, which the replacing Command checks still holds the same word
 * before it edits.
 */
export interface MisspellingContextMenuTarget {
    kind: 'misspelling'
    word: string
    from: number
    to: number
    /** Up to five corrections, best first. */
    suggestions: string[]
}

/** A [[Document]], reached from its tab, a [[Favourite]], [[Recents]], or an All Documents row. */
export interface DocumentContextMenuTarget {
    kind: 'document-tab' | 'favourite' | 'recent' | 'document-row'
    /** The [[Concept]] the row acts on. */
    concept: string
    /** The panel it is open as, when the target IS a tab — what the close rows act on. */
    panelId?: string
}

/**
 * A [[Pane]] tab that is not a [[Document]] — an [[Asset]] tab, All Documents, anything else
 * openable into the main region. It carries no concept, so the document rows do not apply; the
 * tab-management rows (close others, close to the right) do, and those are the whole reason a
 * non-document tab has a menu at all.
 */
export interface TabContextMenuTarget {
    kind: 'tab'
    panelId: string
}

/** The panel a tab-management row acts on, or `null` when the target is not a tab. */
export function tabPanelIdOf(target: ContextMenuTarget): string | null {
    if (target.kind === 'tab') return target.panelId
    return target.kind === 'document-tab' ? (target.panelId ?? null) : null
}

/**
 * An [[Asset Reference]] someone acted on. Downloading it or opening its tab needs nothing but
 * the reference; **editing** it needs to know where it sits, because one line can hold the same
 * asset twice and removing the wrong occurrence looks like nothing happened.
 *
 * So the position is optional, and its absence is the honest answer for a surface that only
 * *shows* a reference — the references [[View]] renders lines out of *other* documents, and the
 * edit would land in the active editor. `asset.delete` is therefore not offered there; see
 * {@link isEditableAssetTarget}. Where a position is given it is resolved when the menu opens,
 * and a command re-finds the reference on that line rather than trusting a stored character
 * offset, which an edit above would have invalidated.
 */
export interface AssetContextMenuTarget {
    kind: 'asset'
    /** The reference exactly as the document writes it, e.g. `../assets/q3.a1b2c3d4.pdf`. */
    ref: string
    /** 1-based line number holding it, at the moment the user acted. */
    line?: number
    /** Which occurrence of `ref` on that line, 0-based. */
    occurrence?: number
}

/** An asset target that carries the position an edit needs. */
export type EditableAssetTarget = AssetContextMenuTarget & { line: number; occurrence: number }

/** Narrowing for a row that acts on a document. */
export function isDocumentTarget(target: ContextMenuTarget): target is DocumentContextMenuTarget {
    return target.kind !== 'asset' && target.kind !== 'tab' && target.kind !== 'wikilink' && target.kind !== 'misspelling'
}

/** Narrowing for a row that acts on a misspelt word. */
export function isMisspellingTarget(target: ContextMenuTarget): target is MisspellingContextMenuTarget {
    return target.kind === 'misspelling'
}

/** Narrowing for a row that acts on a [[Wikilink]]'s concept. */
export function isWikilinkTarget(target: ContextMenuTarget): target is WikilinkContextMenuTarget {
    return target.kind === 'wikilink'
}

/** Narrowing for a row that acts on an [[Asset Reference]]. */
export function isAssetTarget(target: ContextMenuTarget): target is AssetContextMenuTarget {
    return target.kind === 'asset'
}

/**
 * Narrowing for a row that *edits* an [[Asset Reference]] — it needs the position, which only a
 * surface showing the open document can supply.
 */
export function isEditableAssetTarget(target: ContextMenuTarget): target is EditableAssetTarget {
    return isAssetTarget(target) && target.line !== undefined && target.occurrence !== undefined
}

/** One Context Menu row. */
export interface ContextMenuItem {
    /** Stable, namespaced id (e.g. `favourites.add`). */
    id: string
    /** Visible text. A function so it can read the target ("Remove from favourites"). */
    label: string | ((target: ContextMenuTarget) => string)
    /** Sort key; lower sorts earlier. Equal values keep registration order. */
    order?: number
    /** The Command id this row executes, with the target as its argument. */
    command: string
    /** Rendered with a separator above it — groups destructive or unrelated actions. */
    separatorBefore?: boolean
    /** Applicability; absent ⇒ shown for every target. */
    when?: (target: ContextMenuTarget) => boolean
}

/** Register a Context Menu row; returns an unregister fn. */
export function registerContextMenuItem(registry: ContributionRegistry, item: ContextMenuItem): () => void {
    return registry.register(CONTEXT_MENU_KIND, item.id, item)
}

/** The applicable rows for `target`, ordered by `order` then registration order. */
export function listContextMenuItems(
    registry: ContributionRegistry,
    target: ContextMenuTarget,
): { id: string; label: string; command: string; separatorBefore: boolean }[] {
    return registry
        .list(CONTEXT_MENU_KIND)
        .map((e) => e.value as ContextMenuItem)
        .filter((item) => !item.when || item.when(target))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((item) => ({
            id: item.id,
            label: typeof item.label === 'function' ? item.label(target) : item.label,
            command: item.command,
            separatorBefore: item.separatorBefore ?? false,
        }))
}
