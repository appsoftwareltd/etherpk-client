/**
 * `/map`: the Command that puts an empty [[Map Block]] at the caret, and its Command Menu row
 * (ADR 0118). Where the map goes is worked out by `map-insert.ts`; the new map then takes the
 * keyboard into its search box, so the next thing typed finds a place.
 *
 * Not offered where no map would be drawn or where it would break what is there: on a locked
 * document, in a [[Protected Document]], or inside a table.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { getActiveEditorView } from '$lib/document/active-editor'
import { analysisFor } from '$lib/document/view/analysis/editor-analysis'
import { bodyWritable } from '$lib/document/view/body-writable'
import { editorDocument } from '$lib/document/view/editor-document'
import { interactiveFences } from '$lib/document/view/augmentations/interactive-fence-state'

import { MAPS_INSERT } from './identity'
import { type MapInsertPlan, planMapInsert } from './map-insert'

export interface MapCommandDeps {
    /**
     * A new, empty map is about to go into this document: let go of any fold this device keeps for an
     * empty map there, which the new one would share, so it starts open.
     */
    unfoldEmpty(document: string): void
    /** Ask the Map Block at this place in this document to take the keyboard when it mounts. */
    requestFocus(document: string, ordinal: number): void
}

/**
 * Whether `/map` can put a map at the caret of `state`: not in the frontmatter, where its lines would
 * be YAML, nor in a fenced block at any depth (a map's text shown, a code sample), where they would
 * be code, as a table is refused there. The slash menu never opens in either, so this guards the
 * Command however else it runs.
 */
export function mapInsertable(state: EditorState): boolean {
    const { head } = state.selection.main
    const analysis = analysisFor(state)
    if (head <= analysis.frontmatterEnd) return false
    const line = state.doc.lineAt(head).number - 1
    return !analysis.fencedBlocks.some((block) => block.start <= line && line <= block.end)
}

/** Where an empty Map Block goes for the caret of `state`, by the caret's line and the lines beside it (`map-insert.ts`). */
export function mapInsertPlan(state: EditorState): MapInsertPlan {
    const line = state.doc.lineAt(state.selection.main.head)
    const { fencedBlocks, tables, imageLines, frontmatterEnd } = analysisFor(state)
    // Fenced blocks and tables number their lines from 0, image lines from 1.
    const image = (index: number) => imageLines.some((entry) => entry.line === index + 1)
    const starts = (index: number) => fencedBlocks.some((block) => block.start === index) || tables.some((table) => table.startLine === index) || image(index)
    const ends = (index: number) => fencedBlocks.some((block) => block.end === index) || tables.some((table) => table.endLine === index) || image(index)
    const index = line.number - 1
    return planMapInsert(line, {
        before: line.number === 1 || line.from - 1 <= frontmatterEnd ? 'none' : ends(index - 1) ? 'block' : 'plain',
        after: line.number === state.doc.lines ? 'none' : starts(index + 1) ? 'block' : 'plain',
    })
}

/** Put an empty Map Block at the caret of `view`, where one can go (`mapInsertable`). */
export function insertMap(view: EditorView, deps: MapCommandDeps): boolean {
    const { state } = view
    if (state.readOnly || !bodyWritable(state) || !mapInsertable(state)) return false
    const plan = mapInsertPlan(state)
    // Before the dispatch, where the editor reads the fold for the room it keeps for the new map.
    const document = state.facet(editorDocument)?.concept
    if (document) deps.unfoldEmpty(document)
    view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: { anchor: plan.caret }, userEvent: 'input.complete', scrollIntoView: true })
    // The new map is the interactive fence whose block starts where the insert put its opener.
    const opener = plan.from + (plan.insert.startsWith('\n') ? 1 : 0)
    const added = interactiveFences(view.state).find((fence) => fence.blockFrom === view.state.doc.lineAt(opener).from)
    if (document && added) deps.requestFocus(document, added.ordinal)
    return true
}

export function registerMapCommands(context: Pick<ExtensionContext, 'commands' | 'commandMenu'>, deps: MapCommandDeps): void {
    context.commands.register(MAPS_INSERT, () => {
        const view = getActiveEditorView()
        if (view) insertMap(view, deps)
    })
    context.commandMenu.register({
        id: MAPS_INSERT,
        title: 'Map',
        detail: 'Insert a map of places and routes',
        icon: 'map',
        group: 'Insert',
        // After Code block (100) and Table (110): the blocks a person puts in a document.
        order: 115,
        keywords: ['place', 'location', 'route', 'gpx', 'pin', 'coordinates'],
        when: (ctx) => ctx.bodyWritable && !ctx.inTable && !ctx.protectedDocument,
        command: MAPS_INSERT,
    })
}
