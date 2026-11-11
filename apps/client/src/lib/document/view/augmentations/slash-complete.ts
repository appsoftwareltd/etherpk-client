/**
 * Augmentation: the **Command Menu** — a `/`-triggered popover over registered Commands
 * (Dual Mode Editor.md → *Command Menu (slash commands)*). Built on the shared `popoverMenu`
 * primitive (same chrome as wikilink completion). `compute` detects the word-boundary `/`
 * context, gates by editor context (suppressed in code/frontmatter/inside `[[`), and ranks
 * the applicable `CommandMenuItem`s from the active Contribution registry; `accept` deletes
 * the typed `/query` and runs the row's Command through the active Command registry. The
 * Date Picker row's Command opens the sibling calendar (date-calendar.ts). It opens only on a typed
 * `/` (`typesSlash`), never on a caret that arrives behind one. The rows are listed under three
 * headings, Insert, Go to and Settings (`commandMenuGroup`); a heading with no row is not drawn, and
 * the highlight moves from row to row across them.
 *
 * The pure trigger/ranking logic is in `slash-complete-core.ts`; this is the CM binding.
 */

import { type EditorState, type Extension, Facet, StateEffect, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import {
    type CommandMenuContext,
    type CommandMenuGroup,
    type CommandMenuItem,
    commandMenuDetail,
    commandMenuGroup,
    listCommandMenuItems,
    tryGetActiveCommandRegistry,
    tryGetActiveContributionRegistry,
} from '../../../surface'
import { caretConcepts } from '../../caret-concepts'
import { isInCode } from '../../wikilink/code-ranges'
import { fileLinkForCaret } from '../file-link-context'
import { analysisFor } from '../analysis/editor-analysis'
import { bodyWritable } from '../body-writable'
import { caretTask } from '../caret-task'
import { editorDocument } from '../editor-document'
import { showsPartOfDocument } from '../shown-range'
import { isProtectedDocumentFacet } from './protected-document'
import { tableAtCaret, tableInsertable } from '../table-context'
import { type PopoverBase, type PopoverRow, popoverMenu, refreshPopovers } from './popover-menu'
import { iconSvg } from '#lib/surface/icons.js'

import { openWikilinkContext } from './wikilink-complete-core'
import { openSlashContext, rankCommandMenu } from './slash-complete-core'

const commandMenuProbe = Facet.define<(state: EditorState) => MenuState | null>()

/**
 * Whether the Command Menu is open in this editor: the `/` command being typed is not text yet, so
 * a [[Draft]] holds it until the menu closes (draft.ts, ADR 0145 amended 2026-10-16).
 */
export function commandMenuOpen(state: EditorState): boolean {
    return state.facet(commandMenuProbe).some((menu) => (menu(state)?.items.length ?? 0) > 0)
}

/** Whether a command is being typed in this editor: the menu is open, or its query matches no row for now. */
export function commandBeingTyped(state: EditorState): boolean {
    return state.facet(commandMenuProbe).some((menu) => menu(state) !== null)
}

const resumedCommand = StateEffect.define<null>()

/**
 * Pick up a command being typed in an editor that was rebuilt under the person typing it, as a Draft's
 * promotion rebuilds one (DocumentView.svelte). A new state starts with the menu closed, so the caret
 * placed there has not asked for it. Dispatched with the caret already behind the query.
 */
export function resumeCommand(): TransactionSpec {
    return { effects: [resumedCommand.of(null), refreshPopovers.of(null)] }
}

/** A row as the menu shows it: its help text worked out for this caret, under the heading it belongs to. */
type MenuRow = Omit<CommandMenuItem, 'detail' | 'group'> & { detail?: string; group: CommandMenuGroup }

/**
 * What the Command Menu shows in this editor, heading by heading in the order drawn, or nothing
 * while it is shut. A heading with no row is not shown.
 */
export function commandMenuShown(state: EditorState): { group: CommandMenuGroup; titles: string[] }[] {
    const shown: { group: CommandMenuGroup; titles: string[] }[] = []
    for (const menu of state.facet(commandMenuProbe)) {
        for (const item of menu(state)?.items ?? []) {
            const last = shown[shown.length - 1]
            if (last?.group === item.group) last.titles.push(item.title)
            else shown.push({ group: item.group, titles: [item.title] })
        }
    }
    return shown
}

interface MenuState extends PopoverBase {
    items: MenuRow[]
}

/**
 * Whether `tr` is a person typing a `/` at the caret, which is how the menu is asked for: a key, an
 * IME, or the Command Bar's slash button, which dispatches as typing (editor-commands.ts). A caret
 * move, a paste, an undo, a Backspace onto an old `/` and a peer's edit all leave one behind the
 * caret without asking, and an open menu takes Enter, so opening on those would run a row in place
 * of the new line.
 */
function typesSlash(tr: Transaction): boolean {
    if (!tr.isUserEvent('input.type')) return false
    const head = tr.newSelection.main.head
    let typed = false
    // The caret may sit inside what was inserted: a key typed in front of a drawn fence also puts a
    // line break after itself (interactive-fence.ts).
    tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
        if (fromB < head && head <= toB && tr.newDoc.sliceString(head - 1, head) === '/') typed = true
    })
    return typed
}

export function slashCompletion(): Extension {
    function compute(state: EditorView['state']): MenuState | null {
        const sel = state.selection.main
        if (!sel.empty) return null
        const cursor = sel.head
        const line = state.doc.lineAt(cursor)
        const prefix = state.sliceDoc(line.from, cursor)

        const ctx = openSlashContext(prefix)
        if (!ctx) return null
        const anchor = line.from + ctx.slash

        const analysis = analysisFor(state)
        // Suppress in code/frontmatter, and inside an open `[[` (there you pick a concept).
        if (isInCode(analysis.codeRanges, anchor, cursor) || analysis.frontmatterEnd >= anchor) return null
        if (openWikilinkContext(prefix)) return null

        const registry = tryGetActiveContributionRegistry()
        if (!registry) return null
        // The same readings the Commands act on (table-context.ts): a hidden row and a refusing
        // Command always agree.
        // The concepts at the caret walk the document's outline, so they are read only when a row's
        // help text asks for them (`/kanban`'s "For Garden"), once per opening.
        let concepts: readonly string[] | undefined
        const context: CommandMenuContext = {
            inTable: tableAtCaret(state) !== null,
            tableInsertable: tableInsertable(state),
            bodyWritable: bodyWritable(state),
            fileLinkOnLine: fileLinkForCaret(state) !== null,
            taskOnLine: caretTask(state) !== null,
            protectedDocument: state.facet(isProtectedDocumentFacet)(),
            // The Task Editor's description and comments: only rows that act on the text (ADR 0170).
            partOfDocument: showsPartOfDocument(state),
            get conceptsAtCaret() {
                concepts ??= caretConcepts(state.doc.toString(), line.number - 1, state.facet(editorDocument)?.concept ?? null).map((found) => found.concept)
                return concepts
            },
        }
        const applicable = listCommandMenuItems(registry, context)
        // No row may match for now: the menu stays open showing nothing, so deleting the key that
        // matched nothing brings the rows back without typing the `/` again.
        // `rankCommandMenu` keeps each group's rows together, which is what the headings are drawn from.
        const items = rankCommandMenu(applicable, ctx.query).map((item) => ({ ...item, detail: commandMenuDetail(item, context), group: commandMenuGroup(item) }))
        return { anchor, items, selected: 0 }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({
            label: item.title,
            detail: item.detail,
            group: item.group,
            icon: iconSvg(item.icon ?? 'default', { strokeWidth: 1.3 }),
            dataAttrs: { 'data-command': item.command },
        }))
    }

    /** Delete the typed `/query`, then run the row's Command through the registry. */
    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        const item = menu.items[index]
        if (!item) return false
        const cursor = view.state.selection.main.head
        view.dispatch({
            changes: { from: menu.anchor, to: cursor, insert: '' },
            selection: { anchor: menu.anchor },
        })
        const registry = tryGetActiveCommandRegistry()
        if (registry?.has(item.command)) void registry.execute(item.command, item.args)
        return true
    }

    return popoverMenu<MenuState>({
        testid: 'command-menu',
        classPrefix: 'gk-cmd-menu',
        compute,
        rows,
        accept,
        opensOn: (tr) => typesSlash(tr) || tr.effects.some((effect) => effect.is(resumedCommand)),
        openMenu: commandMenuProbe,
    })
}
