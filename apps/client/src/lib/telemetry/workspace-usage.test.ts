import { describe, expect, it } from 'vitest'

import { DEMO_GRAPH_ID } from '#lib/demo/demo-graph.js'

import type { UsageEvent } from './usage-catalogue'
import { createWorkspaceUsage, isDemoPath } from './workspace-usage'

function harness() {
    const events: UsageEvent[] = []
    const usage = createWorkspaceUsage({ record: (event) => void events.push(event) }, new Set(['kanban']))
    return { usage, events, names: () => events.map((event) => event.name) }
}

describe('commands', () => {
    it("reports a Command of the Client's own by its id, never its argument", async () => {
        const { usage, events } = harness()
        usage.commands.register('tasks.open', () => 'opened')
        expect(await usage.commands.execute('tasks.open', 'Garden')).toBe('opened')
        expect(events).toEqual([{ name: 'command.tasks.open' }])
    })

    it("reports a Built-in Extension's Command by its id, and another extension's as an extension's", async () => {
        const { usage, names } = harness()
        usage.extensionCommands.register('kanban.addCard', () => 'added')
        usage.extensionCommands.register('garden-tools.plant', () => 'planted')
        expect(await usage.commands.execute('kanban.addCard')).toBe('added')
        expect(await usage.extensionCommands.execute('garden-tools.plant')).toBe('planted')
        expect(usage.extensionCommands.has('garden-tools.plant')).toBe(true)
        expect(names()).toEqual(['command.kanban.addCard', 'command.extension'])
    })
})

describe('viewOpened', () => {
    it('reports a View by its kind, never what it shows', () => {
        const { usage, events } = harness()
        usage.viewOpened({ kind: 'document', target: 'Garden' })
        usage.viewOpened({ kind: 'tasks', target: '' })
        expect(events).toEqual([{ name: 'view.document' }, { name: 'view.tasks' }])
    })

    it("reports a file's type, never its name", () => {
        const { usage, events } = harness()
        usage.viewOpened({ kind: 'asset', target: 'assets/Garden plan.pdf' })
        usage.viewOpened({ kind: 'asset', target: 'assets/Kitchen.webp' })
        expect(events).toEqual([
            { name: 'view.asset', data: { type: 'pdf' } },
            { name: 'view.asset', data: { type: 'image' } },
        ])
    })

    it("reports a Built-in Extension's View by its kind, and another extension's as an extension's", () => {
        const { usage, names } = harness()
        usage.viewOpened({ kind: 'kanban.board', target: 'Garden' })
        usage.viewOpened({ kind: 'garden-tools.beds', target: 'Garden' })
        expect(names()).toEqual(['view.kanban.board', 'view.extension'])
    })
})

describe('graphOpened', () => {
    it('reports the kind of graph and buckets, never which graph', () => {
        const { usage, events } = harness()
        usage.graphOpened({ graphId: 'g1', synced: true, folder: false, pages: 40, openMs: 800 })
        usage.graphOpened({ graphId: 'g2', synced: false, folder: true, pages: 0, openMs: 4_000 })
        usage.graphOpened({ graphId: 'g3', synced: false, folder: false, pages: 2_000, openMs: 12_000 })
        expect(events).toEqual([
            { name: 'graph_opened', data: { kind: 'synced', pages: '11-100', openTime: '<1s' } },
            { name: 'graph_opened', data: { kind: 'folder', pages: '0', openTime: '3-10s' } },
            { name: 'graph_opened', data: { kind: 'browser', pages: '1000+', openTime: '10s+' } },
        ])
    })

    it('leaves the demo graph out', () => {
        const { usage, events } = harness()
        usage.graphOpened({ graphId: DEMO_GRAPH_ID, synced: false, folder: false, pages: 30, openMs: 500 })
        expect(events).toEqual([])
    })
})

describe('isDemoPath', () => {
    it('is the demo route and every page of the demo graph', () => {
        expect(isDemoPath('/demo')).toBe(true)
        expect(isDemoPath(`/g/${DEMO_GRAPH_ID}`)).toBe(true)
        expect(isDemoPath(`/g/${DEMO_GRAPH_ID}/d/Garden`)).toBe(true)
        expect(isDemoPath('/graphs')).toBe(false)
        expect(isDemoPath('/g/other-graph')).toBe(false)
    })
})
