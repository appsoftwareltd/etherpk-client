import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { assetTargetAt } from './asset-actions'

/**
 * Which reference an element belongs to. The fiddly part of the action cluster: a line can hold
 * the same asset twice, the element is either the widget REPLACING a reference or the cluster
 * sitting just after one, and acting on the wrong occurrence silently removes the wrong text.
 *
 * `assetTargetAt` needs only `posAtDOM` and the document, so a structural fake stands in for the
 * view — no DOM, no mounted editor.
 */
const REF = '../assets/q3-report.a1b2c3d4.pdf'

/** A view whose `posAtDOM` answers `pos` for any element. */
function viewAt(doc: string, pos: number): EditorView {
    const state = EditorState.create({ doc })
    return { state, posAtDOM: () => pos } as unknown as EditorView
}

const el = {} as HTMLElement

describe('assetTargetAt', () => {
    it('reports the line and the only occurrence on it', () => {
        const doc = `first line\n[q3](${REF}) here`
        const view = viewAt(doc, doc.indexOf('[q3]'))

        expect(assetTargetAt(view, el, REF, 'start')).toEqual({
            kind: 'asset',
            ref: REF,
            line: 2,
            occurrence: 0,
        })
    })

    it('tells two references on one line apart by where the element starts', () => {
        const doc = `[a](${REF}) then [b](${REF})`
        const second = doc.indexOf('[b]')

        expect(assetTargetAt(viewAt(doc, 0), el, REF, 'start')?.occurrence).toBe(0)
        expect(assetTargetAt(viewAt(doc, second), el, REF, 'start')?.occurrence).toBe(1)
    })

    it('tells them apart for a cluster sitting AFTER its reference', () => {
        const doc = `[a](${REF}) then [b](${REF})`
        const firstEnd = `[a](${REF})`.length
        const secondEnd = doc.length

        expect(assetTargetAt(viewAt(doc, firstEnd), el, REF, 'end')?.occurrence).toBe(0)
        expect(assetTargetAt(viewAt(doc, secondEnd), el, REF, 'end')?.occurrence).toBe(1)
    })

    it('falls back to the nearest reference at or before the element', () => {
        // A position that matches no edge exactly still resolves, rather than guessing occurrence 0.
        const doc = `[a](${REF}) then [b](${REF})`
        const insideSecond = doc.indexOf('[b]') + 2

        expect(assetTargetAt(viewAt(doc, insideSecond), el, REF, 'start')?.occurrence).toBe(1)
    })

    it('returns null when the line holds no such reference', () => {
        expect(assetTargetAt(viewAt('nothing here', 0), el, REF, 'start')).toBeNull()
    })

    it('returns null when the position cannot be resolved at all', () => {
        const view = {
            state: EditorState.create({ doc: 'x' }),
            posAtDOM: () => {
                throw new Error('detached')
            },
        } as unknown as EditorView

        expect(assetTargetAt(view, el, REF, 'start')).toBeNull()
    })
})
