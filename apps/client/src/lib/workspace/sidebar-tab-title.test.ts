import { describe, expect, it } from 'vitest'

import { sidebarTabTitle } from './sidebar-tab-title'

describe('sidebarTabTitle', () => {
    it('titles the Graph Sidebar tab with the graph name', () => {
        expect(sidebarTabTitle('Notes General', 'g1')).toBe('Notes General')
    })

    it('falls back to "Graph" while the name is not yet known', () => {
        // A synced graph's name arrives with the root doc's meta; until then the tab needs a label.
        expect(sidebarTabTitle('', 'g1')).toBe('Graph')
    })

    it('falls back to "Graph" when the id is standing in for a name', () => {
        // A dev-gate OPFS graph has no registry record, so the workspace lets the id stand in for
        // the settings dialog's name field. A tab titled with a UUID says nothing.
        expect(sidebarTabTitle('g1', 'g1')).toBe('Graph')
    })

    it('keeps a long name whole, leaving the clipping to the tab', () => {
        // Every tab caps its title's WIDTH (TAB_TITLE_CHARS, drawn with an ellipsis), so cutting
        // the string as well would clip graph names shorter than document names, and would hide
        // the rest of the name from the tab's tooltip and accessible name.
        const name = 'Hackers, Painters and Kanban for Software as a Creative Practice'
        expect(sidebarTabTitle(name, 'g1')).toBe(name)
    })

    it('trims surrounding whitespace', () => {
        expect(sidebarTabTitle('  Notes General  ', 'g1')).toBe('Notes General')
    })
})
