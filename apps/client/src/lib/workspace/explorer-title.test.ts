import { describe, expect, it } from 'vitest'

import { explorerTitle, knownGraphName } from './explorer-title'

describe('explorerTitle', () => {
    it('is the View’s name, then the graph’s', () => {
        expect(explorerTitle('My Notes', 'g1')).toBe('Explorer: My Notes')
    })

    it('is the View’s name alone while the graph’s is not known', () => {
        // A synced graph's name arrives with the root doc's meta.
        expect(explorerTitle('', 'g1')).toBe('Explorer')
    })

    it('is the View’s name alone when the id is standing in for a name', () => {
        // A dev-gate OPFS graph has no registry record, so the workspace lets the id stand in for
        // the settings dialog's name field. A title with a UUID in it says nothing.
        expect(explorerTitle('g1', 'g1')).toBe('Explorer')
    })

    it('keeps a long name whole, leaving the clipping to whatever draws it', () => {
        const name = 'Hackers, Painters and Kanban for Software as a Creative Practice'
        expect(explorerTitle(name, 'g1')).toBe(`Explorer: ${name}`)
    })
})

describe('knownGraphName', () => {
    it('trims the name, and is null when there is none', () => {
        expect(knownGraphName('  My Notes  ', 'g1')).toBe('My Notes')
        expect(knownGraphName('   ', 'g1')).toBeNull()
        expect(knownGraphName('g1', 'g1')).toBeNull()
    })
})
