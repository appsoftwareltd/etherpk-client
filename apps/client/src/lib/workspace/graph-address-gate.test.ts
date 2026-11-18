import { describe, expect, it } from 'vitest'

import type { AddressedGraph } from '#lib/navigation/graph-address.js'

import { choiceDetail, gateFor, wrongFolderMessage } from './graph-address-gate'

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
