import { describe, expect, it } from 'vitest'

import { graphHeading, headingText, KINDS, knownGraphName, plainHeading, type OpenGraphKind } from './workspace-heading'

describe('the kinds, as their two icons say them', () => {
    it('a graph is a graph wherever it is kept, and only a synced graph is on a Sync Server', () => {
        expect([KINDS.synced.what, KINDS.synced.kept]).toEqual(['graph', 'synced'])
        expect([KINDS.folder.what, KINDS.folder.kept]).toEqual(['graph', 'device'])
        // The Demo Graph and a dev graph are in the browser's own storage: on this device.
        expect([KINDS.demo.what, KINDS.demo.kept]).toEqual(['graph', 'device'])
        expect([KINDS.browser.what, KINDS.browser.kept]).toEqual(['graph', 'device'])
    })

    it('a Plain Folder is a folder on this device, and a file opened alone is a file on it', () => {
        expect([KINDS.plain.what, KINDS.plain.kept]).toEqual(['folder', 'device'])
        expect([KINDS.file.what, KINDS.file.kept]).toEqual(['file', 'device'])
    })

    it('each has words for the pair, and no two kinds share them', () => {
        const words = Object.values(KINDS).map((kind) => kind.words)
        expect(words).toEqual(['Synced graph', 'Folder graph', 'Demo graph', 'Graph', 'Plain Folder', 'File'])
        expect(new Set(words).size).toBe(words.length)
    })
})

describe('graphHeading', () => {
    it('is the graph’s name, with the kind for its icons', () => {
        expect(graphHeading('synced', 'Garden Notes', 'g1')).toEqual({ name: 'Garden Notes', kind: KINDS.synced })
        expect(headingText(graphHeading('folder', 'Garden Notes', 'g1'))).toBe('Garden Notes')
    })

    it('is the kind in words while the name is not known', () => {
        // A synced graph's name arrives with the root doc's meta.
        expect(headingText(graphHeading('synced', '', 'g1'))).toBe('Synced graph')
        // A graph in the browser's own storage with no record has its id standing in for a name.
        expect(headingText(graphHeading('browser', 'g1', 'g1'))).toBe('Graph')
    })

    it('trims the name and keeps a long one whole, leaving the clipping to the toolbar', () => {
        const name = 'Kitchen, Garden and Greenhouse Notes for Every Season of the Year'
        expect(graphHeading('folder', `  ${name} `, 'g1').name).toBe(name)
    })

    it('has a kind for every graph', () => {
        const kinds: OpenGraphKind[] = ['synced', 'folder', 'demo', 'browser']
        for (const kind of kinds) expect(graphHeading(kind, '', 'g1').kind.what).toBe('graph')
    })
})

describe('plainHeading', () => {
    it('is the folder’s name, as a folder on this device, or as a file when one file is open alone', () => {
        expect(plainHeading('recipes', false)).toEqual({ name: 'recipes', kind: KINDS.plain })
        expect(plainHeading('beans.md', true)).toEqual({ name: 'beans.md', kind: KINDS.file })
    })
})

describe('knownGraphName', () => {
    it('trims the name, and is null when there is none', () => {
        expect(knownGraphName('  My Notes  ', 'g1')).toBe('My Notes')
        expect(knownGraphName('   ', 'g1')).toBeNull()
    })

    it('is null when the id is standing in for a name', () => {
        expect(knownGraphName('g1', 'g1')).toBeNull()
    })
})
