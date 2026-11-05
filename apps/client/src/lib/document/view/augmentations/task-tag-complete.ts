/**
 * Augmentation: the **`#` task-tag helper** — a popover over the [[Task Tag]] actions
 * (ADR 0032's grammar), on the same `popoverMenu` chrome as the `/` Command Menu and
 * wikilink completion.
 *
 * Two decisions worth knowing:
 *
 * 1. **It only fires on a task line.** A `#` anywhere else is prose — the grammar says so —
 *    and offering to insert a tag that the parser would then ignore would be worse than
 *    offering nothing.
 * 2. **It writes into the leading run, not at the cursor.** Tags are metadata *only* in the
 *    contiguous run after the checkbox, so a `#` typed at the end of a sentence still sets
 *    the tag where it counts; the typed `#query` is removed. That is AS Notes' behaviour too,
 *    and it means the user never has to know where the run is.
 *
 * After a letter is typed it also offers the [[Free Tag]]s the graph uses, after those rows. A Free
 * Tag means nothing to the grammar, so a picked one replaces the typed `#query` where it stands.
 * The tags come from the [[Derived Index]], which answers asynchronously, and a popover is computed
 * from editor state, so the answer is kept in a state field and dispatched with `refreshOpenPopovers`.
 * They are asked for when the editor gets focus, because Enter on a tag ending a line depends on
 * knowing it is one, and again when the caret first gets behind a `#`. Asking there and not on each
 * keystroke keeps a word half typed on this line out of them.
 *
 * The pure trigger/ranking logic is in `task-tag-complete-core.ts`; this is the CM binding.
 */

import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { TrustedMarkup } from '#lib/security/trusted-types.js'
import { iconSvg } from '#lib/surface/icons.js'

import { applyTaskTag } from '../../task-tags'
import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'
import { openDateCalendar } from './date-calendar'
import { closePopovers, type PopoverBase, type PopoverRow, popoverMenu, refreshOpenPopovers } from './popover-menu'
import { openTaskTagContext, type TaskTagItem, taskTagMenu } from './task-tag-complete-core'
import { openWikilinkContext } from './wikilink-complete-core'

interface MenuState extends PopoverBase {
    items: TaskTagItem[]
    /** Document range of the typed `#query`, removed when a row is chosen. */
    from: number
    to: number
}

const ROW_ICONS: Record<TaskTagItem['action']['kind'], string> = {
    priority: 'flag',
    waiting: 'clock',
    doing: 'clock',
    test: 'clock',
    cancelled: 'clock',
    archived: 'clock',
    date: 'calendar',
    'free-tag': 'tag',
}

function iconFor(item: TaskTagItem): TrustedMarkup {
    return iconSvg(ROW_ICONS[item.action.kind], { strokeWidth: 1.3 })
}

/** Where the graph's Free Tags come from; the workspace's index, or null while it has none. */
export interface GraphFreeTagSource {
    freeTags(): Promise<string[]>
}

export interface TaskTagCompletionOptions {
    freeTags: () => GraphFreeTagSource | null
}

/** The index's Free Tags landed. Exported for the tests, which play the index's part. */
export const learnedFreeTags = StateEffect.define<readonly string[]>()

const graphFreeTags = StateField.define<readonly string[]>({
    create: () => [],
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(learnedFreeTags)) value = effect.value
        return value
    },
})

/** The `#query` the caret is behind, where a tag would be metadata, or null. */
function tagContextAt(state: EditorState): { from: number; to: number; query: string; lineWithoutQuery: string } | null {
    const sel = state.selection.main
    if (!sel.empty) return null
    const cursor = sel.head
    const line = state.doc.lineAt(cursor)

    // Only where a tag would actually BE metadata (decision 1 above).
    if (applyTaskTag(line.text, { kind: 'waiting' }) === null) return null

    const prefix = state.sliceDoc(line.from, cursor)
    const rest = state.sliceDoc(cursor, line.to)
    const ctx = openTaskTagContext(prefix, rest)
    if (!ctx) return null
    const from = line.from + ctx.hash
    const analysis = analysisFor(state)
    if (isInCode(analysis.codeRanges, from, cursor) || analysis.frontmatterEnd >= from) return null
    // Inside an open `[[` the user is naming a concept, not tagging — the `/` menu
    // stands down there for the same reason.
    if (openWikilinkContext(prefix)) return null

    return { from, to: cursor, query: ctx.query, lineWithoutQuery: prefix.slice(0, ctx.hash) + rest }
}

/** Asks the index for the graph's Free Tags on focus and when the caret gets behind a `#`, and keeps the answer. */
function fetchFreeTags(options: TaskTagCompletionOptions): Extension {
    return ViewPlugin.fromClass(
        class {
            private behindHash = false
            private latest = 0
            private destroyed = false

            // Not on every construction: a Journal Roll builds an editor per day, and only the one
            // with focus can be typed in.
            constructor(view: EditorView) {
                if (view.hasFocus) this.ask(view)
            }

            update(update: ViewUpdate): void {
                if (update.focusChanged && update.view.hasFocus) this.ask(update.view)
                if (!update.docChanged && !update.selectionSet) return
                const behindHash = tagContextAt(update.state) !== null
                if (behindHash && !this.behindHash) this.ask(update.view)
                this.behindHash = behindHash
            }

            private ask(view: EditorView): void {
                const source = options.freeTags()
                if (!source) return
                const asked = ++this.latest
                // A failed read leaves the rows as they were, and the next `#` asks again.
                source.freeTags().then(
                    (tags) => {
                        if (this.destroyed || asked !== this.latest) return
                        view.dispatch({ effects: [learnedFreeTags.of(tags), refreshOpenPopovers.of(null)] })
                    },
                    () => {},
                )
            }

            destroy(): void {
                this.destroyed = true
            }
        },
    )
}

export function taskTagCompletion(options?: TaskTagCompletionOptions): Extension {
    function compute(state: EditorState): MenuState | null {
        const ctx = tagContextAt(state)
        if (!ctx) return null
        // No rows is still an open menu, one that shows nothing and takes no keys, so an answer
        // from the index can fill it.
        const { items, selected } = taskTagMenu(ctx.query, state.field(graphFreeTags), ctx.lineWithoutQuery)
        return { anchor: ctx.from, selected, items, from: ctx.from, to: ctx.to }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({
            label: item.label,
            detail: item.detail,
            icon: iconFor(item),
            dataAttrs: { kind: item.action.kind },
        }))
    }

    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        const item = menu.items[index]
        if (!item) return false

        if (item.action.kind === 'free-tag') {
            // The caret ends at the end of the word, where the menu would reopen and take the next Enter.
            view.dispatch({
                changes: { from: menu.from, to: menu.to, insert: item.detail },
                selection: { anchor: menu.from + item.detail.length },
                effects: closePopovers.of(null),
                userEvent: 'input.complete',
            })
            return true
        }

        // Remove the typed `#query` first, in its own transaction, so both arms below then
        // reason about a line that no longer contains it.
        view.dispatch({ changes: { from: menu.from, to: menu.to, insert: '' }, userEvent: 'input.complete' })

        const line = view.state.doc.lineAt(menu.from)
        if (item.action.kind === 'date') {
            // The calendar owns the rest: it rewrites the run when a day is picked. Anchored
            // where the `#` was — any position on the line resolves to the same line, and
            // this one is where the user is looking.
            view.dispatch({
                effects: openDateCalendar.of({
                    pos: menu.from,
                    target: { kind: 'task-tag', tag: item.action.tag },
                }),
            })
            return true
        }

        const next = applyTaskTag(line.text, item.action)
        if (next === null) return true
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: next },
            selection: { anchor: line.from + next.length },
            userEvent: 'input.complete',
        })
        return true
    }

    return [
        graphFreeTags,
        options ? fetchFreeTags(options) : [],
        popoverMenu<MenuState>({
            testid: 'task-tag-menu',
            classPrefix: 'gk-task-tag',
            compute,
            rows,
            accept,
        }),
    ]
}
