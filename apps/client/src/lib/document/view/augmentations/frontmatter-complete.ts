/**
 * Augmentation: completion inside [[Frontmatter]] (ADR 0108), on the same `popoverMenu` chrome as
 * the `/` Command Menu and wikilink completion. What is offered and where is
 * `frontmatter-complete-core.ts`; this module is the binding, and the one part the core cannot
 * do: fetching the keys and values the rest of the graph uses from the [[Derived Index]].
 *
 * The index answers asynchronously, and a popover is computed from editor state, so what the
 * index said is kept in a state field, and the answer is dispatched with `refreshPopovers` so the
 * popover recomputes when it lands. The keys are asked
 * for when the caret first reaches a key in the block, and asked again after a while so a key
 * added elsewhere turns up; a key's values are asked for the first time they are needed.
 */

import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { PropertyKeyInfo, PropertyValueInfo } from '../../index-db'
import { frontmatterHead } from '../frontmatter-text'
import { type FrontmatterCompletionItem, completionContext, rankFrontmatterItems, valueSourceOf } from './frontmatter-complete-core'
import { type PopoverBase, type PopoverRow, popoverMenu, refreshPopovers } from './popover-menu'

/** Where the graph's keys and values come from; the workspace's index, or null while it has none. */
export interface GraphPropertySource {
    propertyKeys(): Promise<PropertyKeyInfo[]>
    propertyValues(key: string): Promise<PropertyValueInfo[]>
}

export interface FrontmatterCompletionOptions {
    properties: () => GraphPropertySource | null
}

/** How long the keys the index gave are trusted before they are asked for again. */
const KEYS_TTL_MS = 30_000
/** Rows the popover shows at most: typing narrows it. */
const MAX_ROWS = 12

interface GraphProperties {
    keys: readonly PropertyKeyInfo[]
    values: ReadonlyMap<string, readonly PropertyValueInfo[]>
}

/** The index's keys landed. Exported for the tests, which play the index's part. */
export const learnedKeys = StateEffect.define<readonly PropertyKeyInfo[]>()
/** The index's values for one key landed. */
export const learnedValues = StateEffect.define<{ key: string; values: readonly PropertyValueInfo[] }>()

const graphProperties = StateField.define<GraphProperties>({
    create: () => ({ keys: [], values: new Map() }),
    update(value, tr) {
        let next = value
        for (const effect of tr.effects) {
            if (effect.is(learnedKeys)) next = { ...next, keys: effect.value }
            if (effect.is(learnedValues)) next = { ...next, values: new Map(next.values).set(effect.value.key, effect.value.values) }
        }
        return next
    },
})

/** The block with the line terminator after it, when the caret is inside it; else null. */
function blockAtCaret(state: EditorState): string | null {
    const selection = state.selection.main
    if (!selection.empty) return null
    const head = frontmatterHead(state)
    // The caret on the closing delimiter's terminator is past the block.
    return head !== null && selection.head < head.length ? head : null
}

/** Asks the index for what the caret's context needs, and hands the answers to the state field. */
function fetchPlugin(options: FrontmatterCompletionOptions): Extension {
    return ViewPlugin.fromClass(
        class {
            private keysAt = -Infinity
            private readonly asked = new Set<string>()
            private destroyed = false

            update(update: ViewUpdate): void {
                if (update.docChanged || update.selectionSet) this.ask(update.view)
            }

            private ask(view: EditorView): void {
                const block = blockAtCaret(view.state)
                const ctx = block === null ? null : completionContext(block, view.state.selection.main.head)
                const source = options.properties()
                if (!ctx || !source) return
                // The answer and a refresh together: the popover's rows are recomputed from it at once.
                const land = (effect: StateEffect<unknown>) => {
                    if (!this.destroyed) view.dispatch({ effects: [effect, refreshPopovers.of(null)] })
                }
                if (ctx.kind === 'key' && ctx.parent === null && Date.now() - this.keysAt > KEYS_TTL_MS) {
                    this.keysAt = Date.now()
                    source.propertyKeys().then((keys) => land(learnedKeys.of(keys)), () => (this.keysAt = -Infinity))
                }
                if (ctx.kind === 'value') {
                    const key = valueSourceOf(ctx.key)
                    if (this.asked.has(key)) return
                    this.asked.add(key)
                    source.propertyValues(key).then((values) => land(learnedValues.of({ key, values })), () => this.asked.delete(key))
                }
            }

            destroy(): void {
                this.destroyed = true
            }
        },
    )
}

interface MenuState extends PopoverBase {
    items: FrontmatterCompletionItem[]
    /** The typed text a row replaces. */
    from: number
    to: number
}

export function frontmatterCompletion(options: FrontmatterCompletionOptions): Extension {
    function compute(state: EditorState): MenuState | null {
        const block = blockAtCaret(state)
        if (block === null) return null
        const ctx = completionContext(block, state.selection.main.head)
        if (!ctx) return null
        const known = state.field(graphProperties, false) ?? { keys: [], values: new Map() }
        const items = rankFrontmatterItems(block, ctx, { graphKeys: known.keys, graphValues: (key) => known.values.get(key) ?? [] }).slice(0, MAX_ROWS)
        if (items.length === 0) return null
        return { anchor: ctx.from, selected: 0, items, from: ctx.from, to: ctx.to }
    }

    function rows(menu: MenuState): PopoverRow[] {
        return menu.items.map((item) => ({ label: item.label, detail: item.detail }))
    }

    function accept(view: EditorView, menu: MenuState, index: number): boolean {
        const item = menu.items[index]
        if (!item) return false
        view.dispatch({
            changes: { from: menu.from, to: menu.to, insert: item.insert },
            selection: { anchor: menu.from + item.insert.length },
            userEvent: 'input.complete',
        })
        return true
    }

    return [
        graphProperties,
        fetchPlugin(options),
        popoverMenu<MenuState>({ testid: 'frontmatter-complete', classPrefix: 'gk-fm-complete', compute, rows, accept }),
    ]
}
