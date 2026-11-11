import { EditorState, type TransactionSpec } from '@codemirror/state'
import { type KeyBinding, keymap, showTooltip } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { type PopoverRow, popoverMenu, popoverSections, refreshOpenPopovers, refreshPopovers } from './popover-menu'

/** An open menu over `rowCount()` rows, driven through its own keymap, without a DOM. */
function openMenu(rowCount: () => number, computed: () => number = () => 0) {
    let highlighted: number | null = null
    let state = EditorState.create({
        doc: 'water',
        extensions: popoverMenu({
            testid: 'menu',
            classPrefix: 'menu',
            compute: () => ({ anchor: 0, selected: computed() }),
            rows: (menu) => {
                highlighted = menu.selected
                return Array.from({ length: rowCount() }, (_, n) => ({ label: `Row ${n}` }))
            },
            accept: () => true,
        }),
    })
    const view = {
        get state() {
            return state
        },
        dispatch(spec: TransactionSpec) {
            state = state.update(spec).state
        },
    }
    const highlight = () => {
        // The tooltip facet reads the rows of the menu as the state now has it.
        state.facet(showTooltip)
        return highlighted
    }
    const key = (name: string) => {
        const binding = state.facet(keymap).flat().find((candidate: KeyBinding) => candidate.key === name)
        return binding!.run!(view as never)
    }
    return { view, highlight, key }
}

describe('the popover menu', () => {
    it('keeps a highlight the keys moved when an answer from the index lands', () => {
        const menu = openMenu(() => 3)
        menu.key('ArrowDown')
        menu.key('ArrowDown')
        expect(menu.highlight()).toBe(2)
        menu.view.dispatch({ effects: refreshOpenPopovers.of(null) })
        expect(menu.highlight()).toBe(2)
    })

    it('stays shut when an answer for open menus lands, and a refresh still opens it', () => {
        const menu = openMenu(() => 3)
        const open = () => menu.view.state.facet(showTooltip).filter(Boolean).length
        expect(open()).toBe(1)
        menu.key('Escape')
        expect(open()).toBe(0)
        menu.view.dispatch({ effects: refreshOpenPopovers.of(null) })
        expect(open()).toBe(0)
        menu.view.dispatch({ effects: refreshPopovers.of(null) })
        expect(open()).toBe(1)
    })

    it('takes the highlight the rows now start on when the keys have not moved it', () => {
        let start = 0
        const menu = openMenu(() => 3, () => start)
        expect(menu.highlight()).toBe(0)
        start = -1
        menu.view.dispatch({ effects: refreshPopovers.of(null) })
        expect(menu.highlight()).toBe(-1)
    })

    it('keeps a moved highlight on a row that is still there when fewer land', () => {
        let rows = 3
        const menu = openMenu(() => rows)
        menu.key('ArrowUp')
        expect(menu.highlight()).toBe(2)
        rows = 2
        menu.view.dispatch({ effects: refreshPopovers.of(null) })
        expect(menu.highlight()).toBe(1)
    })

    it('starts the highlight again once the text changes', () => {
        const menu = openMenu(() => 3)
        menu.key('ArrowDown')
        menu.view.dispatch({ changes: { from: 5, insert: 's' } })
        expect(menu.highlight()).toBe(0)
    })

    it('reaches the first row with Down and the last with Up from no highlight', () => {
        const down = openMenu(() => 3, () => -1)
        down.key('ArrowDown')
        expect(down.highlight()).toBe(0)
        const up = openMenu(() => 3, () => -1)
        up.key('ArrowUp')
        expect(up.highlight()).toBe(2)
    })
})

// A menu whose rows name a heading is drawn in groups (the Command Menu's Insert, Go to, Settings).
// The headings are drawn from the rows, never counted among them.
describe('the sections a menu’s rows are drawn in', () => {
    const row = (label: string, group?: string): PopoverRow => ({ label, group })
    const shape = (rows: PopoverRow[]) => popoverSections(rows).map((section) => ({ group: section.group, start: section.start, labels: section.rows.map((r) => r.label) }))

    it('is one section per run of neighbouring rows under the same heading, each starting at its first row’s index', () => {
        expect(shape([row('Table', 'Insert'), row('Today', 'Insert'), row('Search', 'Go to'), row('Spell check', 'Settings')])).toEqual([
            { group: 'Insert', start: 0, labels: ['Table', 'Today'] },
            { group: 'Go to', start: 2, labels: ['Search'] },
            { group: 'Settings', start: 3, labels: ['Spell check'] },
        ])
    })

    it('has no section for a heading with no row', () => {
        expect(shape([row('Search', 'Go to')])).toEqual([{ group: 'Go to', start: 0, labels: ['Search'] }])
        expect(shape([])).toEqual([])
    })

    it('is a single section with no heading for rows that name none, as a wikilink completion’s are', () => {
        expect(shape([row('Garden'), row('Kitchen')])).toEqual([{ group: undefined, start: 0, labels: ['Garden', 'Kitchen'] }])
    })
})
