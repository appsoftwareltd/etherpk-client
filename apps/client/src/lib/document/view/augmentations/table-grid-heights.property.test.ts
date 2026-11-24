import { EditorState, RangeSet } from '@codemirror/state'
import { type Decoration, EditorView } from '@codemirror/view'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { analysisFor, editorAnalysis } from '../analysis/editor-analysis'
import { cellSpan, tableRange } from '../table-cell'
import { isHiddenText } from './base-renderer'
import { markdownTableAugmentation } from './markdown-table'
import { gridHeightAt, keepGridHeights } from './table-grid-heights'

/**
 * A grid keeps the height it was last drawn at through any edit (table-grid-heights.ts): text put
 * in or taken out above it or between two tables, a line written straight above it, and text typed
 * in a cell, its own or another table's. No edit loses a height or gives one table another's, and the widget drawn for each
 * table next is told that height, which is what keeps the page from jumping while it is measured.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

const word = fc.constantFrom('beans', 'kale', 'water twice', 'April', 'the far bed', 'x')

/** A table: with its outer pipes or without, on a line of its own or as a bullet's content. */
const table = fc.record({ rows: fc.integer({ min: 1, max: 4 }), pipes: fc.boolean(), bullet: fc.boolean() }).map(({ rows, pipes, bullet }) => {
    const line = (cells: string[]) => (pipes ? `| ${cells.join(' | ')} |` : cells.join(' | '))
    const lines = [line(['Crop', 'Sow']), line(['---', '---']), ...Array.from({ length: rows }, (_, i) => line([`crop ${i}`, 'April']))]
    return bullet ? lines.map((each, i) => (i === 0 ? `- ${each}` : `  ${each}`)).join('\n') : lines.join('\n')
})

/** A page: a paragraph, then tables with a paragraph after each. */
const page = fc.array(table, { minLength: 1, maxLength: 4 }).map((tables) => ['The beds.', ...tables.flatMap((each, i) => [each, `after table ${i}`])].join('\n\n'))

type Edit = { kind: 'above'; table: number; text: string } | { kind: 'before'; table: number; text: string } | { kind: 'remove'; table: number } | { kind: 'cell'; table: number; row: number; column: number; text: string } | { kind: 'start'; table: number; text: string }

const edit: fc.Arbitrary<Edit> = fc.oneof(
    fc.record({ kind: fc.constant('above' as const), table: fc.nat(3), text: word }),
    // A line put in straight above the table, as a sync or a file change writes it: the text goes in where the table starts.
    fc.record({ kind: fc.constant('before' as const), table: fc.nat(3), text: word }),
    fc.record({ kind: fc.constant('remove' as const), table: fc.nat(3) }),
    fc.record({ kind: fc.constant('cell' as const), table: fc.nat(3), row: fc.integer({ min: -1, max: 3 }), column: fc.nat(1), text: word }),
    // Typed in front of the first cell's text: in a table written without its outer pipes, that is where the table starts.
    fc.record({ kind: fc.constant('start' as const), table: fc.nat(3), text: word }),
)

const tablesOf = (state: EditorState) => analysisFor(state).tables
const startOf = (state: EditorState, index: number) => tableRange(state, tablesOf(state)[index]).from

/** The edit as a change to `state`, or null where the page has no such table, cell or paragraph. */
function changeFor(state: EditorState, each: Edit): { from: number; to?: number; insert?: string } | null {
    const target = tablesOf(state)[each.table]
    if (!target) return null
    // The paragraph above the table: two lines up from its first row, past the empty line.
    const above = state.doc.line(target.startLine - 1)
    if (each.kind === 'above') return { from: above.to, insert: `\n\n${each.text}` }
    if (each.kind === 'before') return { from: state.doc.line(target.startLine + 1).from, insert: `${each.text}\n\n` }
    if (each.kind === 'remove') return above.text === '' || above.number === 1 ? null : { from: above.from, to: above.to, insert: 'kept' }
    if (each.kind === 'start') return { from: cellSpan(state, target, { row: -1, column: 0 })!.from, insert: each.text }
    const span = cellSpan(state, target, { row: each.row, column: each.column })
    return span ? { from: span.from, to: span.to, insert: each.text } : null
}

/** The height each grid's widget was told, in the order the tables are in. */
function widgetHeights(state: EditorState): number[] {
    const out: number[] = []
    for (const source of state.facet(EditorView.decorations)) {
        if (!(source instanceof RangeSet)) continue
        source.between(0, state.doc.length, (_from, _to, deco: Decoration) => {
            if (deco.spec.widget && !isHiddenText(deco)) out.push(deco.spec.widget.estimatedHeight)
        })
    }
    return out
}

describe('the height a grid was last drawn at', () => {
    it('stays with its table through edits above it, between tables and in cells', () => {
        fc.assert(
            fc.property(page, fc.array(edit, { maxLength: 12 }), (doc, edits) => {
                let state = EditorState.create({ doc, extensions: [editorAnalysis(), markdownTableAugmentation()] })
                const count = tablesOf(state).length
                const heights = Array.from({ length: count }, (_, i) => 100 + i * 37)
                keepGridHeights(state, heights.map((height, i) => [startOf(state, i), height] as const))

                for (const each of edits) {
                    const change = changeFor(state, each)
                    if (!change) continue
                    state = state.update({ changes: change }).state
                    // The edits here add and remove no table.
                    expect(tablesOf(state)).toHaveLength(count)
                    expect(heights.map((_, i) => gridHeightAt(state, startOf(state, i)))).toEqual(heights)
                    expect(widgetHeights(state)).toEqual(heights)
                }
            }),
            fuzz(300),
        )
    })

    it('is dropped with its table', () => {
        let state = EditorState.create({ doc: 'The beds.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter', extensions: [editorAnalysis(), markdownTableAugmentation()] })
        const from = startOf(state, 0)
        keepGridHeights(state, [[from, 120]])
        state = state.update({ changes: { from, to: state.doc.length, insert: 'words where the table was' } }).state
        expect(gridHeightAt(state, from)).toBe(-1)
    })

    it('is unknown for a table not drawn yet', () => {
        const state = EditorState.create({ doc: '| a | b |\n| - | - |\n| 1 | 2 |', extensions: [editorAnalysis(), markdownTableAugmentation()] })
        expect(gridHeightAt(state, 0)).toBe(-1)
        expect(widgetHeights(state)).toEqual([-1])
    })
})
