import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyEditorPosition, clampSelection, revealEditorPosition } from './view-position'

describe('clampSelection', () => {
    it('passes an in-range selection through', () => {
        expect(clampSelection({ scrollTop: 0, anchor: 3, head: 7 }, 10)).toEqual({
            anchor: 3,
            head: 7,
        })
    })
    it('clamps offsets beyond the doc length (doc changed since capture)', () => {
        expect(clampSelection({ scrollTop: 0, anchor: 25, head: 30 }, 10)).toEqual({
            anchor: 10,
            head: 10,
        })
    })
    it('floors negatives from a corrupt payload', () => {
        expect(clampSelection({ scrollTop: 0, anchor: -2, head: 4 }, 10)).toEqual({
            anchor: 0,
            head: 4,
        })
    })
})

describe('applyEditorPosition', () => {
    /** Run every queued animation frame until none is left. */
    let frames: FrameRequestCallback[] = []
    beforeEach(() => {
        frames = []
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    })
    afterEach(() => vi.unstubAllGlobals())
    const runFrames = () => {
        for (let n = 0; n < 500 && frames.length > 0; n++) frames.shift()!(0)
    }

    /**
     * Just enough of an EditorView: its state, a scroller and its root element. The scroller does
     * not move on its own, which stands for a panel that has not been laid out yet.
     */
    function fakeView(doc: string) {
        let state = EditorState.create({ doc })
        const dom = Object.assign(new EventTarget(), { isConnected: true })
        const view = {
            get state() {
                return state
            },
            dispatch(spec: TransactionSpec) {
                state = state.update(spec).state
            },
            scrollDOM: { scrollTop: 0 },
            dom,
        }
        return view as typeof view & EditorView
    }

    it('holds the restored scroll while the editor settles', () => {
        const view = fakeView('a\n'.repeat(100))
        applyEditorPosition(view, { scrollTop: 300, anchor: 0, head: 0 })
        // Layout settling resets the scroller, and the restore puts it back.
        view.scrollDOM.scrollTop = 0
        runFrames()
        expect(view.scrollDOM.scrollTop).toBe(300)
    })

    it.each(['keydown', 'pointerdown', 'wheel', 'touchstart', 'paste', 'beforeinput'])(
        'lets go once the person acts on the editor (%s)',
        (type) => {
            const view = fakeView('a\n'.repeat(100))
            applyEditorPosition(view, { scrollTop: 0, anchor: 0, head: 0 })
            // The person types at once, and the editor scrolls to their caret.
            view.dom.dispatchEvent(new Event(type))
            view.scrollDOM.scrollTop = 900
            runFrames()
            expect(view.scrollDOM.scrollTop).toBe(900)
        },
    )
})

describe('revealEditorPosition', () => {
    let frames: FrameRequestCallback[] = []
    beforeEach(() => {
        frames = []
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    })
    afterEach(() => vi.unstubAllGlobals())
    const runFrames = () => {
        for (let n = 0; n < 500 && frames.length > 0; n++) frames.shift()!(0)
    }

    /** An editor whose target never comes into view, so the reveal keeps asking to scroll to it. */
    function fakeView(doc: string) {
        let state = EditorState.create({ doc })
        const dom = Object.assign(new EventTarget(), { isConnected: true })
        const view = {
            scrolls: 0,
            get state() {
                return state
            },
            dispatch(spec: TransactionSpec) {
                if (spec.effects) view.scrolls += 1
                state = state.update(spec).state
            },
            coordsAtPos: () => null,
            scrollDOM: { scrollTop: 0, clientHeight: 400, scrollHeight: 4000, getBoundingClientRect: () => ({ top: 0, bottom: 400 }) },
            defaultLineHeight: 20,
            dom,
        }
        return view as typeof view & EditorView
    }

    it('keeps scrolling to the target while it is out of sight', () => {
        const view = fakeView('a\n'.repeat(100))
        revealEditorPosition(view, 10)
        runFrames()
        expect(view.scrolls).toBeGreaterThan(10)
    })

    it('lets go once the person acts on the editor', () => {
        const view = fakeView('a\n'.repeat(100))
        revealEditorPosition(view, 10)
        const before = view.scrolls
        // The person pastes a moment after the reveal: the editor follows their caret from here.
        view.dom.dispatchEvent(new Event('beforeinput'))
        runFrames()
        expect(view.scrolls).toBe(before)
    })
})
