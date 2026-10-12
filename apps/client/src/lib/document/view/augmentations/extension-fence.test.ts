import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { replaceFenceLine } from '../../fence-body'
import { editorAnalysis } from '../analysis/editor-analysis'
import { extensionFencePlaceholder } from './extension-fence-placeholder'
import { extensionFenceAtomRanges, extensionFenceCaret, fenceEditChanges, interactiveFenceAugmentation, widgetEditsChanges } from './interactive-fence'
import { type InteractiveFence, isExtensionFenceInfo, registerInteractiveFence } from './interactive-fence-contract'
import { collapsedInteractiveFences, fenceIdAt, interactiveFences } from './interactive-fence-state'
import { isProtectedDocumentFacet } from './protected-document'
import { requestReveal } from './reveal-policy'

// Extension Fences (ADR 0138): a fence named `<extension id>.<name>` holds an extension's data. It is
// drawn whether or not the extension runs (its widget, or a placeholder), the caret alone never shows
// its text, and the caret passes over it as one block. The caret rows are in
// outliner-keymap.rules.test.ts; these check the pieces.

const drawing: InteractiveFence = {
    height: () => 400,
    mount: () => ({ update: () => {}, destroy: () => {} }),
    identify: (body) => body[0]?.match(/"id":"([^"]+)"/)?.[1] ?? null,
}

beforeEach(() => {
    const registry = createContributionRegistry()
    registerInteractiveFence(registry, 'garden.plan', drawing)
    setActiveContributionRegistry(registry)
})

afterEach(() => setActiveContributionRegistry(null))

function state(doc: string, anchor = 0, protectedDocument = false): EditorState {
    return EditorState.create({
        doc,
        selection: { anchor },
        extensions: [editorAnalysis(), interactiveFenceAugmentation(), isProtectedDocumentFacet.of(() => protectedDocument)],
    })
}

const plan = (...body: string[]) => ['```garden.plan', ...body, '```'].join('\n')
const doc = ['Intro', plan('{"id":"k1"}', '{"e":1}', '{"e":2}'), 'After'].join('\n')

describe('which info words name an Extension Fence', () => {
    it('is an extension id, a dot and a name', () => {
        expect(isExtensionFenceInfo('excalidraw.drawing')).toBe(true)
        expect(isExtensionFenceInfo('garden-tools.plan')).toBe(true)
    })

    it('is not a bare word, a language or a dotted name of another shape', () => {
        for (const info of ['video', 'map', 'mermaid', 'c++', 'Garden.plan', 'a.b.c', '.plan', 'garden.', 'objective-c']) {
            expect(isExtensionFenceInfo(info)).toBe(false)
        }
    })
})

describe('drawing an Extension Fence', () => {
    it('is drawn by its registered widget', () => {
        expect(interactiveFences(state(doc)).map((f) => [f.info, f.fence])).toEqual([['garden.plan', drawing]])
    })

    it('is drawn as a placeholder naming its extension when nothing is registered for it', () => {
        setActiveContributionRegistry(createContributionRegistry())
        const fences = interactiveFences(state(doc))
        expect(fences.map((f) => f.fence)).toEqual([extensionFencePlaceholder('garden.plan')])
    })

    it('is left as text in a Protected Document, where nothing is drawn', () => {
        expect(interactiveFences(state(doc, 0, true))).toEqual([])
    })

    it('stays drawn with the caret on its lines or a selection reaching into it', () => {
        const insideBody = doc.indexOf('{"e":1}')
        expect(collapsedInteractiveFences(state(doc, insideBody))).toHaveLength(1)
        const s = state(doc).update({ selection: EditorSelection.range(0, doc.length) }).state
        expect(collapsedInteractiveFences(s)).toHaveLength(1)
    })

    it('shows its text when asked, until the selection leaves it', () => {
        const s = state(doc)
        const [fence] = interactiveFences(s)
        const shown = s.update({ selection: { anchor: doc.indexOf('{"e":1}') }, effects: requestReveal.of({ from: fence.blockFrom, to: fence.blockTo }) }).state
        expect(collapsedInteractiveFences(shown)).toEqual([])
        // Moving within its text keeps it shown, leaving it draws it again.
        const within = shown.update({ selection: { anchor: doc.indexOf('{"e":2}') } }).state
        expect(collapsedInteractiveFences(within)).toEqual([])
        const left = within.update({ selection: { anchor: doc.length } }).state
        expect(collapsedInteractiveFences(left)).toHaveLength(1)
    })
})

describe('where the caret may rest beside an Extension Fence', () => {
    it('cannot rest from the end of the line above to the start of the line below', () => {
        const ranges: [number, number][] = []
        extensionFenceAtomRanges(state(doc)).between(0, doc.length, (from, to) => {
            ranges.push([from, to])
        })
        const opener = doc.indexOf('```garden.plan')
        const after = doc.indexOf('After')
        expect(ranges).toEqual([[opener - 1, after]])
    })

    it('moves a caret placed on its lines beside it, on past it going down and above it going up', () => {
        const s = EditorState.create({ doc, extensions: [editorAnalysis(), interactiveFenceAugmentation(), extensionFenceCaret()] })
        const down = s.update({ selection: { anchor: doc.indexOf('{"e":1}') } }).state
        expect(down.selection.main.head).toBe(doc.indexOf('After'))
        const up = down.update({ selection: { anchor: doc.indexOf('{"e":2}') } }).state
        expect(up.selection.main.head).toBe('Intro'.length)
    })

    it('rests a caret an edit leaves on its lines where it may, above it', () => {
        const s = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [editorAnalysis(), interactiveFenceAugmentation(), extensionFenceCaret()] })
        const edited = s.update({ changes: { from: doc.length, insert: '!' }, selection: { anchor: doc.indexOf('{"e":1}') } }).state
        expect(edited.selection.main.head).toBe('Intro'.length)
    })

    it('widens a text range that ends on its lines to take the whole fence', () => {
        const s = EditorState.create({ doc, extensions: [editorAnalysis(), interactiveFenceAugmentation(), extensionFenceCaret()] })
        const placed = s.update({ selection: EditorSelection.range(0, doc.indexOf('{"e":1}')) }).state
        expect(placed.selection.main.to).toBe(doc.indexOf('\nAfter'))
    })
})

describe("a widget's edits", () => {
    it('apply several line changes together as one change, each read after the last', () => {
        const s = state(doc)
        const id = fenceIdAt(s, doc.indexOf('```garden.plan'))!
        const changes = widgetEditsChanges(s, id, [replaceFenceLine(1, '{"e":1}', '{"e":1,"v":2}'), { kind: 'insert', line: 3, text: '{"e":3}' }])
        expect(changes).not.toBeNull()
        expect(s.update({ changes: changes! }).state.doc.toString()).toBe(['Intro', plan('{"id":"k1"}', '{"e":1,"v":2}', '{"e":2}', '{"e":3}'), 'After'].join('\n'))
    })

    it('make no change at all when any one of them no longer applies', () => {
        const s = state(doc)
        const id = fenceIdAt(s, doc.indexOf('```garden.plan'))!
        expect(widgetEditsChanges(s, id, [replaceFenceLine(1, '{"e":1}', '{"e":9}'), replaceFenceLine(2, '{"e":99}', '{"e":8}')])).toBeNull()
    })

    it('leave two whole lines, not one mixed line, when two devices replace the same line', () => {
        // Each device's replacement as the editor writes it, applied to the same Y.Text as the
        // CodeMirror binding writes a change: a deletion of the range, then an insertion.
        const s = state(doc)
        const fence = interactiveFences(s)[0]
        const mine = fenceEditChanges(s, fence, replaceFenceLine(1, '{"e":1}', '{"e":1,"v":2}')) as { from: number; to: number; insert: string }
        const theirs = fenceEditChanges(s, fence, replaceFenceLine(1, '{"e":1}', '{"e":1,"v":3}')) as { from: number; to: number; insert: string }
        const a = new Y.Doc()
        const b = new Y.Doc()
        a.getText('t').insert(0, doc)
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
        for (const [ydoc, change] of [
            [a, mine],
            [b, theirs],
        ] as const) {
            const text = ydoc.getText('t')
            text.delete(change.from, change.to - change.from)
            text.insert(change.from, change.insert)
        }
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
        const merged = a.getText('t').toString().split('\n')
        expect(merged).toContain('{"e":1,"v":2}')
        expect(merged).toContain('{"e":1,"v":3}')
    })
})
