/**
 * Editing at several carets, at random: whatever is typed or deleted at a column of carets is what
 * the same edit made on each line by itself gives, and the changes handed to the store one at a
 * time (sequential-text-changes.ts) write the same text.
 */
import { deleteCharBackwardStrict } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { editorAnalysis, analysisFor } from './analysis/editor-analysis'
import { localHistoryExtension } from './editor-history'
import { sequentialTextChanges } from './sequential-text-changes'
import { textFileExtensions } from './text-file'

const SEED = Number(process.env.EDITOR_FUZZ_SEED ?? 20261123)
const RUNS = Number(process.env.EDITOR_FUZZ_RUNS ?? 300)

const line = fc.constantFrom('', '- beans', '  - peas', '```', '---', '| a | b |', '# Soil', 'plain text', '![p](a.png)')
const edits = fc.array(fc.oneof(fc.constantFrom('x', '- ', '`', '# ', '|').map((text) => ({ insert: text })), fc.constant({ insert: null })), { minLength: 1, maxLength: 6 })

describe('editing at several carets in the Text Editor, at random', () => {
    it('is the same edit made on each line by itself, and reaches the store as the same text', () => {
        fc.assert(
            fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), fc.nat(10), edits, fc.constantFrom('README.md', 'water.yaml'), (lines, col, steps, name) => {
                let state = EditorState.create({ doc: lines.join('\n'), extensions: [localHistoryExtension(), textFileExtensions(name), editorAnalysis()] })
                const carets = lines.map((_, n) => {
                    const at = state.doc.line(n + 1)
                    return EditorSelection.cursor(at.from + Math.min(col, at.length))
                })
                state = state.update({ selection: EditorSelection.create(carets) }).state
                let stored = state.doc.toString()
                // Each line on its own, with its own caret.
                const model = lines.map((text: string) => ({ text, caret: Math.min(col, text.length) }))
                for (const each of steps) {
                    let tr: Transaction | undefined
                    if (each.insert !== null) tr = state.update(state.replaceSelection(each.insert), { userEvent: 'input.type' })
                    else {
                        // A caret at a line's start would join lines: the model is of edits within a line.
                        if (model.some((row) => row.caret === 0)) continue
                        deleteCharBackwardStrict({ state, dispatch: (made: Transaction) => void (tr = made) } as never)
                    }
                    if (!tr) continue
                    for (const change of sequentialTextChanges(tr.changes)) stored = stored.slice(0, change.from) + change.insert + stored.slice(change.to)
                    state = tr.state
                    for (const row of model) {
                        const start = each.insert === null ? row.caret - 1 : row.caret
                        row.text = row.text.slice(0, start) + (each.insert ?? '') + row.text.slice(row.caret)
                        row.caret = start + (each.insert ?? '').length
                    }
                    expect(state.doc.toJSON()).toEqual(model.map((row) => row.text))
                    expect(state.selection.ranges).toHaveLength(lines.length)
                    expect(stored).toBe(state.doc.toString())
                    expect(analysisFor(state).lines).toEqual(state.doc.toJSON())
                }
            }),
            { seed: SEED, numRuns: RUNS },
        )
    })
})
