import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { graphRequest } from './graph-request'

describe('graphRequest', () => {
    it('reads --folder as a graph folder, resolved to an absolute path', () => {
        expect(graphRequest('serve', { folder: '/notes/kitchen' })).toEqual({ kind: 'folder', path: '/notes/kitchen' })
        expect(graphRequest('serve', { folder: 'kitchen' })).toEqual({ kind: 'folder', path: resolve('kitchen') })
    })

    it('reads --graph as a synced graph, with the Sync Server when one is named', () => {
        expect(graphRequest('serve', { graph: 'Garden' })).toEqual({ kind: 'synced', wanted: 'Garden', server: undefined })
        expect(graphRequest('serve', { graph: 'Garden', 'sync-server': 'https://sync.example.com' })).toEqual({
            kind: 'synced',
            wanted: 'Garden',
            server: 'https://sync.example.com',
        })
    })

    it('refuses no graph at all, and refuses a folder with a synced graph', () => {
        expect(() => graphRequest('serve', {})).toThrow('serve needs --graph <id or name>, or --folder <path>')
        expect(() => graphRequest('publish', { folder: '/notes', graph: 'Garden' })).toThrow('publish takes either --folder <path> or --graph')
        expect(() => graphRequest('serve', { folder: '/notes', 'sync-server': 'https://sync.example.com' })).toThrow('not both')
    })

    // The Claude Code plugin passes every flag on every start, with an empty value for each option
    // the person left unset (`claude-plugin.test.ts`). An empty or blank flag is one not given.
    // Every combination of absent, empty, blank and given for the three flags, which is the whole
    // space the rule is about.
    const states = [undefined, '', '  ', 'given'] as const
    const cases = states.flatMap((graph) => states.flatMap((folder) => states.map((server) => ({ graph, folder, server }))))
    it.each(cases)('reads an empty or blank flag as one not given: graph $graph, folder $folder, server $server', ({ graph, folder, server }) => {
        const value = { graph: 'Garden', folder: '/notes/kitchen', server: 'https://sync.example.com' }
        const flag = (state: (typeof states)[number], given: string) => (state === 'given' ? given : state)
        const isGiven = (state: (typeof states)[number]) => state === 'given'
        const run = () => graphRequest('serve', { graph: flag(graph, value.graph), folder: flag(folder, value.folder), 'sync-server': flag(server, value.server) })

        if (isGiven(folder) && (isGiven(graph) || isGiven(server))) expect(run).toThrow('not both')
        else if (isGiven(folder)) expect(run()).toEqual({ kind: 'folder', path: value.folder })
        else if (isGiven(graph)) expect(run()).toEqual({ kind: 'synced', wanted: value.graph, server: isGiven(server) ? value.server : undefined })
        else expect(run).toThrow('needs --graph')
    })
})
