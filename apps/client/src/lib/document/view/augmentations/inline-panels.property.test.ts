import { EditorState } from '@codemirror/state'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from '../analysis/editor-analysis'
import { addInlinePanel, inlinePanelsField, inlinePanelWidgets, removeInlinePanel } from './inline-panels'
import { isProtectedDocumentFacet } from './protected-document'

/**
 * A panel is never held in a Protected Document, whatever order things happen in: panels opening
 * and closing, text typed, removed or arriving whole, and the document becoming protected or
 * ordinary again between them. A document's own answer changes outside the editor (its stored text
 * is read, another device protects it), so the editor learns of it only at its next transaction:
 * after every transaction, a protected document holds no panel and draws none.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261124 : Number(seed) }
}

type Step =
    | { kind: 'open'; id: number; at: number; end: boolean }
    | { kind: 'close'; id: number }
    | { kind: 'insert'; at: number; text: string }
    | { kind: 'remove'; from: number; length: number }
    | { kind: 'protect'; on: boolean }
    | { kind: 'tick' }

const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant('open' as const), id: fc.integer({ min: 1, max: 3 }), at: fc.nat(60), end: fc.boolean() }),
    fc.record({ kind: fc.constant('close' as const), id: fc.integer({ min: 1, max: 3 }) }),
    fc.record({ kind: fc.constant('insert' as const), at: fc.nat(60), text: fc.constantFrom('- water the beans\n', 'x', '\n', '  - basil\n', '---\ntitle: Diary\n---\n```etherpk-cipher\nv1:c2VjcmV0\n```\n') }),
    fc.record({ kind: fc.constant('remove' as const), from: fc.nat(60), length: fc.nat(12) }),
    fc.record({ kind: fc.constant('protect' as const), on: fc.boolean() }),
    fc.record({ kind: fc.constant('tick' as const) }),
)

describe('inline panels, over any order of events', () => {
    it('hold and draw no panel in a Protected Document after any transaction', () => {
        fc.assert(
            fc.property(fc.constantFrom('', '- Garden\n- Kitchen\n'), fc.array(step, { maxLength: 30 }), (doc, steps) => {
                let protectedDocument = false
                let state = EditorState.create({ doc, extensions: [editorAnalysis(), inlinePanelsField, isProtectedDocumentFacet.of(() => protectedDocument)] })
                for (const next of steps) {
                    if (next.kind === 'protect') {
                        // Outside the editor: no transaction says so.
                        protectedDocument = next.on
                        continue
                    }
                    const length = state.doc.length
                    if (next.kind === 'open') {
                        const lineStart = next.end ? state.doc.lineAt(length).from : state.doc.lineAt(Math.min(next.at, length)).from
                        state = state.update({ effects: addInlinePanel.of({ id: next.id, lineStart, mode: next.end ? 'end' : 'line' }) }).state
                    } else if (next.kind === 'close') state = state.update({ effects: removeInlinePanel.of(next.id) }).state
                    else if (next.kind === 'insert') state = state.update({ changes: { from: Math.min(next.at, length), insert: next.text } }).state
                    else if (next.kind === 'remove') {
                        const from = Math.min(next.from, length)
                        state = state.update({ changes: { from, to: Math.min(from + next.length, length) } }).state
                    } else state = state.update({}).state
                    if (protectedDocument) {
                        expect(state.field(inlinePanelsField)).toEqual([])
                        expect(inlinePanelWidgets(state)).toEqual([])
                    }
                }
            }),
            fuzz(300),
        )
    })

    it('keep every panel opened and not closed in a document that is never protected', () => {
        fc.assert(
            fc.property(fc.constantFrom('', '- Garden\n- Kitchen\n'), fc.array(step, { maxLength: 30 }), (doc, steps) => {
                let state = EditorState.create({ doc, extensions: [editorAnalysis(), inlinePanelsField, isProtectedDocumentFacet.of(() => false)] })
                const open = new Set<number>()
                for (const next of steps) {
                    const length = state.doc.length
                    if (next.kind === 'open') {
                        const lineStart = next.end ? state.doc.lineAt(length).from : state.doc.lineAt(Math.min(next.at, length)).from
                        state = state.update({ effects: addInlinePanel.of({ id: next.id, lineStart, mode: next.end ? 'end' : 'line' }) }).state
                        open.add(next.id)
                    } else if (next.kind === 'close') {
                        state = state.update({ effects: removeInlinePanel.of(next.id) }).state
                        open.delete(next.id)
                    } else if (next.kind === 'insert') state = state.update({ changes: { from: Math.min(next.at, length), insert: next.text } }).state
                    else if (next.kind === 'remove') {
                        const from = Math.min(next.from, length)
                        state = state.update({ changes: { from, to: Math.min(from + next.length, length) } }).state
                    } else state = state.update({}).state
                    expect(
                        state
                            .field(inlinePanelsField)
                            .map((spot) => spot.id)
                            .sort(),
                    ).toEqual([...open].sort())
                }
            }),
            fuzz(300),
        )
    })
})
