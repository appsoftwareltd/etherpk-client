import { describe, expect, it } from 'vitest'

import type { AddressedGraph } from '#lib/navigation/graph-address.js'

import { choiceDetail, entryIsAnotherGraphs, foldersNamedHeading, gateFor, graphAskedFor, graphIdsNamed, wrongFolderMessage } from './graph-address-gate'

const folder = (id: string, name: string): AddressedGraph => ({ id, backend: 'filesystem', handle: { kind: 'directory', name } })
const browser = (id: string): AddressedGraph => ({ id, backend: 'filesystem', where: 'browser', handle: { kind: 'directory', name: `graph-${id}` } })

describe('gateFor', () => {
    const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), browser('b1')]

    it('opens a synced graph by its id, without the registry: the workspace says what is missing', () => {
        expect(gateFor({ where: 'sync', name: 's1' }, [], false)).toEqual({ kind: 'open', graphId: 's1', createInBrowser: false })
    })

    it('opens the folder graph this browser holds under the name', () => {
        expect(gateFor({ where: 'folder', name: 'reports' }, graphs, false)).toEqual({ kind: 'open', graphId: 'f1', createInBrowser: false })
    })

    it('asks for a folder this browser does not hold', () => {
        expect(gateFor({ where: 'folder', name: 'garden' }, graphs, false)).toEqual({ kind: 'choose-folder' })
        // Development makes no folder graph out of a name either.
        expect(gateFor({ where: 'folder', name: 'garden' }, graphs, true)).toEqual({ kind: 'choose-folder' })
    })

    it('offers the folders that share a name', () => {
        expect(gateFor({ where: 'folder', name: 'notes' }, graphs, false)).toEqual({ kind: 'choose-graph', graphs: [graphs[1], graphs[2]] })
    })

    it('opens a graph kept in the browser, and never makes one outside development', () => {
        expect(gateFor({ where: 'browser', name: 'b1' }, graphs, false)).toEqual({ kind: 'open', graphId: 'b1', createInBrowser: false })
        expect(gateFor({ where: 'browser', name: 'new' }, graphs, false)).toEqual({ kind: 'not-in-browser' })
        expect(gateFor({ where: 'browser', name: 'new' }, graphs, true)).toEqual({ kind: 'open', graphId: 'new', createInBrowser: true })
    })
})

describe('gateFor, with the graph a person chose in EtherPK', () => {
    const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), browser('b1')]
    const notes = { where: 'folder', name: 'notes' } as const

    it('opens the chosen one of two folders with one name, without asking', () => {
        expect(gateFor(notes, graphs, false, 'f3')).toEqual({ kind: 'open', graphId: 'f3', createInBrowser: false })
        expect(gateFor(notes, graphs, false, 'f2')).toEqual({ kind: 'open', graphId: 'f2', createInBrowser: false })
    })

    it('still asks when the choice is a graph the address does not name', () => {
        // Another folder, a graph that was forgotten since, and another kind of graph.
        for (const chosen of ['f1', 'gone', 'b1']) {
            expect(gateFor(notes, graphs, false, chosen)).toEqual({ kind: 'choose-graph', graphs: [graphs[1], graphs[2]] })
        }
    })

    it('never opens the chosen graph in place of the one graph the address names', () => {
        expect(gateFor({ where: 'folder', name: 'reports' }, graphs, false, 'f2')).toEqual({ kind: 'open', graphId: 'f1', createInBrowser: false })
        expect(gateFor({ where: 'folder', name: 'garden' }, graphs, false, 'f2')).toEqual({ kind: 'choose-folder' })
        expect(gateFor({ where: 'sync', name: 's1' }, graphs, false, 'f2')).toEqual({ kind: 'open', graphId: 's1', createInBrowser: false })
    })
})

describe('graphAskedFor', () => {
    it('is the graph a real navigation or Back names, when it is not the one open', () => {
        expect(graphAskedFor({ type: 'goto', shallow: false }, 'f3', 'f2')).toBe('f3')
        expect(graphAskedFor({ type: 'popstate' }, 'f3', 'f2')).toBe('f3')
        // Back onto another graph's entry is flagged shallow when no route changed.
        expect(graphAskedFor({ type: 'popstate', shallow: true }, 'f3', 'f2')).toBe('f3')
        expect(graphAskedFor({ type: 'link' }, 'f3', null)).toBe('f3')
    })

    it('is none when the entry names the open graph, or no graph', () => {
        expect(graphAskedFor({ type: 'popstate' }, 'f2', 'f2')).toBeNull()
        expect(graphAskedFor({ type: 'goto', shallow: false }, null, 'f2')).toBeNull()
    })

    it('is none for a workspace\'s own write to its entry, which may be a closed workspace\'s', () => {
        expect(graphAskedFor({ type: 'goto', shallow: true }, 'f3', 'f2')).toBeNull()
    })
})

describe('graphIdsNamed', () => {
    const graphs = [folder('f1', 'reports'), folder('f2', 'notes'), folder('f3', 'notes'), browser('b1')]

    it('is every registered graph the address names', () => {
        expect(graphIdsNamed({ where: 'folder', name: 'notes' }, graphs)).toEqual(['f2', 'f3'])
        expect(graphIdsNamed({ where: 'folder', name: 'reports' }, graphs)).toEqual(['f1'])
        expect(graphIdsNamed({ where: 'folder', name: 'garden' }, graphs)).toEqual([])
    })
})

describe('entryIsAnotherGraphs', () => {
    it('is an entry of the other folder with the open graph\'s address', () => {
        expect(entryIsAnotherGraphs('f3', 'f2', ['f2', 'f3'])).toBe(true)
    })

    it('is not the open graph\'s own entry, nor one that names no graph', () => {
        expect(entryIsAnotherGraphs('f2', 'f2', ['f2', 'f3'])).toBe(false)
        expect(entryIsAnotherGraphs(undefined, 'f2', ['f2', 'f3'])).toBe(false)
    })

    it('is not an entry written under an id the address no longer names: a folder forgotten and chosen again', () => {
        expect(entryIsAnotherGraphs('f-old', 'f2', ['f2'])).toBe(false)
        expect(entryIsAnotherGraphs('f-old', 'f2', ['f2', 'f3'])).toBe(false)
    })
})

describe('wrongFolderMessage', () => {
    it('accepts the folder the link names', () => {
        expect(wrongFolderMessage('reports', 'reports')).toBeNull()
    })

    it('refuses another folder with both names', () => {
        expect(wrongFolderMessage('notes', 'reports')).toBe('That folder is named “notes”. This link is for “reports”. Choose the folder named “reports”.')
    })

    it('treats a difference in case as another folder, as the address does', () => {
        expect(wrongFolderMessage('Reports', 'reports')).not.toBeNull()
    })
})

describe('foldersNamedHeading', () => {
    it('says how many folders share the name, as many as the choices under it', () => {
        expect(foldersNamedHeading(2, 'notes')).toBe('Two folders are named “notes”')
        expect(foldersNamedHeading(3, 'docs')).toBe('Three folders are named “docs”')
        expect(foldersNamedHeading(9, 'docs')).toBe('Nine folders are named “docs”')
        expect(foldersNamedHeading(12, 'docs')).toBe('12 folders are named “docs”')
    })
})

describe('choiceDetail', () => {
    const added = new Date(2026, 10, 18, 9, 5).getTime()

    it('says when the folder was added, to the minute, so two added on one day differ', () => {
        expect(choiceDetail({ createdAt: added, path: null }, 'en-GB')).toBe('Added 18 Nov 2026, 09:05')
        expect(choiceDetail({ createdAt: added + 60_000, path: null }, 'en-GB')).toBe('Added 18 Nov 2026, 09:06')
    })

    it('leads with the path where the person has given EtherPK one', () => {
        expect(choiceDetail({ createdAt: added, path: '/home/me/work/reports' }, 'en-GB')).toBe('/home/me/work/reports · added 18 Nov 2026, 09:05')
    })
})
