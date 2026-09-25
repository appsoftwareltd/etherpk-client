/**
 * Augmentation: the **Command Menu** — a `/`-triggered popover over registered Commands
 * (Dual Mode Editor.md → *Command Menu (slash commands)*). Built on the shared `popoverMenu`
 * primitive (same chrome as wikilink completion). `compute` detects the word-boundary `/`
 * context, gates by editor context (suppressed in code/frontmatter/inside `[[`), and ranks
 * the applicable `CommandMenuItem`s from the active Contribution registry; `accept` deletes
 * the typed `/query` and runs the row's Command through the active Command registry. The
 * Date Picker row's Command opens the sibling calendar (date-calendar.ts).
 *
 * The pure trigger/ranking logic is in `slash-complete-core.ts`; this is the CM binding.
 */

import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import {
    type CommandMenuItem,
    listCommandMenuItems,
    tryGetActiveCommandRegistry,
    tryGetActiveContributionRegistry,
} from '../../../surface'
import { isInCode } from '../../wikilink/code-ranges'
import { fileLinkForCaret } from '../file-link-context'
import { analysisFor } from '../analysis/editor-analysis'
import { bodyWritable } from '../body-writable'
import { tableAtCaret, tableInsertable } from '../table-context'
import { type PopoverBase, type PopoverRow, popoverMenu } from './popover-menu'
import { iconSvg } from '$lib/surface/icons'

import { openWikilinkContext } from './wikilink-complete-core'
import { openSlashContext, rankCommandMenu } from './slash-complete-core'

interface MenuState extends PopoverBase {
    items: CommandMenuItem[]
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
        const applicable = listCommandMenuItems(registry, {
            inTable: tableAtCaret(state) !== null,
            tableInsertable: tableInsertable(state),
            bodyWritable: bodyWritable(state),
            fileLinkOnLine: fileLinkForCaret(state) !== null,
        })
        const items = rankCommandMenu(applicable, ctx.query)
        if (items.length === 0) return null
        return { anchor, items, selected: 0 }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({
            label: item.title,
            detail: item.detail,
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
    })
}
