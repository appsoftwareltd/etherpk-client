import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { type EditorView, keymap, showTooltip } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { createCommandRegistry } from '../../../surface/command-registry'
import { setActiveCommandRegistry } from '../../../surface/active-commands'
import { conceptPicker, showConceptPicker } from './concept-picker'
import { refreshPopovers } from './popover-menu'

// The concept picker (EtherPK's own, with the Command Menu's keys): a list at the caret that a
// Command opens, `/kanban` the first (ADR 0113). It lives until the user picks, leaves, edits or
// moves the caret, and a pick runs the Command it was opened for.

/** The surface the picker and its keys use in a live view: the state, and a dispatch. */
function headlessView(doc: string) {
    let state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [conceptPicker()] })
    const view = {
        get state() {
            return state
        },
        dispatch(...specs: TransactionSpec[]) {
            state = state.update(...specs).state
        },
    }
    return view as unknown as EditorView
}

function isOpen(view: EditorView): boolean {
    return view.state.facet(showTooltip).some(Boolean)
}

/** Press a key through the editor's keymaps, highest precedence first, as a live view does. */
function press(view: EditorView, key: string): boolean {
    for (const bindings of view.state.facet(keymap)) {
        for (const binding of bindings) if (binding.key === key && binding.run?.(view)) return true
    }
    return false
}

const request = {
    pos: 5,
    rows: [
        { concept: 'Acme', detail: 'In this block' },
        { concept: 'Planning', detail: 'This page' },
    ],
    command: 'test.pick',
    label: 'Open a Kanban board for',
}

afterEach(() => setActiveCommandRegistry(null))

describe('the concept picker', () => {
    it('opens at the caret, and stays open through a transaction that changes nothing it reads', () => {
        const view = headlessView('- abc')
        expect(isOpen(view)).toBe(false)
        showConceptPicker(view, request)
        expect(isOpen(view)).toBe(true)
        view.dispatch({})
        expect(isOpen(view)).toBe(true)
    })

    it('closes on an edit, a caret move, Escape or a refresh, and does not come back', () => {
        const closers: Array<(view: EditorView) => void> = [
            (view) => view.dispatch({ changes: { from: 5, insert: 'd' } }),
            (view) => view.dispatch({ selection: EditorSelection.cursor(0) }),
            (view) => press(view, 'Escape'),
            (view) => view.dispatch({ effects: refreshPopovers.of(null) }),
        ]
        for (const close of closers) {
            const view = headlessView('- abc')
            showConceptPicker(view, request)
            close(view)
            expect(isOpen(view)).toBe(false)
            view.dispatch({ effects: refreshPopovers.of(null) })
            expect(isOpen(view)).toBe(false)
        }
    })

    it('runs its Command with the concept picked, and closes', () => {
        const picked: unknown[] = []
        const registry = createCommandRegistry()
        registry.register('test.pick', (arg) => void picked.push(arg))
        setActiveCommandRegistry(registry)
        const view = headlessView('- abc')
        showConceptPicker(view, request)

        press(view, 'ArrowDown')
        press(view, 'Enter')

        expect(picked).toEqual([{ concept: 'Planning' }])
        expect(isOpen(view)).toBe(false)
        expect(view.state.doc.toString()).toBe('- abc')
    })
})
