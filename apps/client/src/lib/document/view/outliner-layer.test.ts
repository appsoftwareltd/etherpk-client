import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { enterListItem, indentListItem, outdentListItem, plainLists } from './list-items-keymap'
import { outlinerLayer } from './outliner-layer'
import { indentBranch } from './outliner-keymap'

/** Every binding of the state, in the order a key press tries them. */
const bindings = (state: EditorState) => state.facet(keymap).flat()
const runsFor = (state: EditorState, key: string) => bindings(state).filter((binding) => binding.key === key).map((binding) => binding.run)

describe('the outliner’s keys as an editor loads them', () => {
    it('in the plain profile, tries the other list kinds before the outliner’s own', () => {
        const state = EditorState.create({ extensions: outlinerLayer({ plain: true }) })
        expect(state.facet(plainLists)).toBe(true)
        expect(runsFor(state, 'Tab')[0]).toBe(indentListItem)
        expect(runsFor(state, 'Shift-Tab')[0]).toBe(outdentListItem)
        expect(runsFor(state, 'Enter')[0]).toBe(enterListItem)
        expect(runsFor(state, 'Tab').indexOf(indentListItem)).toBeLessThan(runsFor(state, 'Tab').indexOf(indentBranch))
    })

    it('in a graph, has neither those keys nor the profile', () => {
        const state = EditorState.create({ extensions: outlinerLayer({ plain: false }) })
        expect(state.facet(plainLists)).toBe(false)
        const all = bindings(state).map((binding) => binding.run)
        for (const command of [indentListItem, outdentListItem, enterListItem]) expect(all).not.toContain(command)
        expect(runsFor(state, 'Tab')).toContain(indentBranch)
    })
})
