import { describe, expect, it, vi } from 'vitest'

import type { ExtensionContext, ExtensionManifest, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import type { Catalogue, CatalogueEntry } from './catalogue'
import { createExtensionHost } from './host'
import { createExtensionSwitches } from './switches'
import { fakeClientServices, fakeGraphServices, memoryStorage } from './testing'

const view: ViewContribution = { mount: () => ({ destroy() {} }) }

function manifest(id: string, rest: Partial<ExtensionManifest> = {}): ExtensionManifest {
    return { id, displayName: id === 'kanban' ? 'Kanban' : 'Graph View', publisher: 'App Software', main: './src/extension.ts', ...rest }
}

/** Kanban compiled in, supplying its board, and the Graph View loaded, supplying its whole graph. */
function setUp(options: { kanban?: (context: ExtensionContext) => void | (() => void); importModule?: (url: string) => Promise<unknown>; off?: string[] } = {}) {
    const kanbanActivate = vi.fn(
        options.kanban ??
            ((context: ExtensionContext) => {
                context.views.register('kanban.board', view)
            }),
    )
    const graphViewActivate = vi.fn((context: ExtensionContext) => {
        context.views.register('graph-view.whole', view)
    })
    const kanban: CatalogueEntry = {
        id: 'kanban',
        source: 'compiled-in',
        module: { activate: kanbanActivate },
        package: {
            name: '@appsoftwareltd/etherpk-extension-kanban',
            version: '0.8.54',
            manifest: manifest('kanban', {
                icons: { kanban: '<rect/>' },
                views: [{ kind: 'kanban.board', title: 'Kanban: {target}', icon: 'kanban', region: 'main', address: { segment: 'k', target: 'concept' } }],
            }),
        },
    }
    const graphView: CatalogueEntry = {
        id: 'graph-view',
        source: 'loaded',
        base: '/extensions/graph-view/0.8.54/',
        package: {
            name: '@appsoftwareltd/etherpk-extension-graph-view',
            version: '0.8.54',
            manifest: manifest('graph-view', {
                main: './dist/main.js',
                minClientVersion: '0.8.54',
                styles: ['./dist/main.css'],
                views: [
                    { kind: 'graph-view.local', target: 'local', title: 'Graph View', icon: 'link', region: 'right-sidebar', resident: { side: 'right', desktopOnly: true } },
                    { kind: 'graph-view.whole', target: 'whole', title: 'Whole graph', region: 'main', address: { segment: 'graph-view' } },
                ],
            }),
        },
    }
    const catalogue: Catalogue = { extensions: [kanban, graphView], broken: [] }
    const importModule = vi.fn(options.importModule ?? (async () => ({ activate: graphViewActivate })))
    const storage = memoryStorage()
    const switches = createExtensionSwitches(storage)
    for (const id of options.off ?? []) switches.set(id, false)
    const host = createExtensionHost({ catalogue, client: fakeClientServices(storage), switches, importModule })
    const graph = fakeGraphServices()
    return { host, graph, switches, importModule, kanbanActivate, graphViewActivate }
}

const slotOf = (host: ReturnType<typeof setUp>['host'], kind: string) => host.views().find((declared) => declared.declaration.kind === kind)!.slot

describe('the extension host', () => {
    it('declares every View kind before any extension runs, with its title, icon and residency', () => {
        const { host, kanbanActivate } = setUp()
        const views = host.views()
        expect(views.map((declared) => declared.declaration.kind)).toEqual(['kanban.board', 'graph-view.local', 'graph-view.whole'])
        const board = views[0]
        expect(board.title({ kind: 'kanban.board', target: 'Q4' })).toBe('Kanban: Q4')
        expect(board.titlePrefix).toBe('Kanban: ')
        expect(board.icon).toBe('kanban.kanban')
        expect(board.conceptTarget).toBe(true)
        expect(views[1].icon).toBe('link')
        expect(views[2].titlePrefix).toBeUndefined()
        expect(host.residents()).toEqual([{ kind: 'graph-view.local', side: 'right', desktopOnly: true, fallback: { kind: 'graph-view.local', target: 'local' } }])
        expect(host.icons()).toEqual({ 'kanban.kanban': '<rect/>' })
        expect(kanbanActivate).not.toHaveBeenCalled()
    })

    it('isolates a loaded extension\'s Views with its stylesheets, and leaves a compiled-in one in the page', () => {
        const { host } = setUp()
        expect(slotOf(host, 'kanban.board').isolation).toBeNull()
        expect(slotOf(host, 'graph-view.whole').isolation).toEqual({ styles: ['/extensions/graph-view/0.8.54/dist/main.css'] })
    })

    it('starts every extension that is on when a graph opens, importing a loaded one from its own address', async () => {
        const { host, graph, importModule, kanbanActivate, graphViewActivate } = setUp()
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'waiting' })
        await host.start(graph.services)
        expect(kanbanActivate).toHaveBeenCalledTimes(1)
        expect(importModule).toHaveBeenCalledWith('/extensions/graph-view/0.8.54/dist/main.js')
        expect(graphViewActivate).toHaveBeenCalledTimes(1)
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'ready', view })
        expect(host.status('kanban')).toEqual({ state: 'running' })
        expect(host.status('graph-view')).toEqual({ state: 'running' })
    })

    it('starts a compiled-in extension before start returns, so a restored tab never shows it loading', () => {
        const { host, graph, kanbanActivate } = setUp()
        void host.start(graph.services)
        expect(kanbanActivate).toHaveBeenCalledTimes(1)
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'ready', view })
        expect(host.status('graph-view')).toEqual({ state: 'starting' })
    })

    it('marks a declared View the extension never supplied as failed, rather than loading for ever', async () => {
        const { host, graph } = setUp()
        await host.start(graph.services)
        expect(slotOf(host, 'graph-view.local').state()).toEqual({ status: 'failed', message: 'Graph View did not supply this View.' })
    })

    it('keeps one extension failing from stopping the others, and says why it failed', async () => {
        const { host, graph } = setUp({
            kanban: () => {
                throw new Error('no board today')
            },
        })
        await host.start(graph.services)
        expect(host.status('kanban')).toEqual({ state: 'failed', message: 'no board today' })
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'failed', message: 'Kanban could not start: no board today' })
        expect(host.status('graph-view')).toEqual({ state: 'running' })
    })

    it('fails a loaded extension whose bundle cannot be fetched, or exports no activate', async () => {
        const missing = setUp({ importModule: async () => Promise.reject(new Error('Failed to fetch dynamically imported module')) })
        await missing.host.start(missing.graph.services)
        expect(missing.host.status('graph-view')).toEqual({ state: 'failed', message: 'Failed to fetch dynamically imported module' })
        const empty = setUp({ importModule: async () => ({}) })
        await empty.host.start(empty.graph.services)
        expect(empty.host.status('graph-view')).toEqual({ state: 'failed', message: 'dist/main.js does not export an activate function.' })
    })

    it('takes everything back when the graph closes, calling what activate returned last', async () => {
        const order: string[] = []
        const { host, graph } = setUp({
            kanban: (context) => {
                context.views.register('kanban.board', view)
                context.commands.register('kanban.openBoard', () => {})
                return () => order.push(`returned, command still there: ${graph.services.commands.has('kanban.openBoard')}`)
            },
        })
        await host.start(graph.services)
        host.stop()
        expect(order).toEqual(['returned, command still there: false'])
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'waiting' })
        expect(host.status('kanban')).toEqual({ state: 'idle' })
    })

    it('starts nothing for an extension switched off, whose Views say so', async () => {
        const { host, graph, kanbanActivate } = setUp({ off: ['kanban'] })
        await host.start(graph.services)
        expect(kanbanActivate).not.toHaveBeenCalled()
        expect(host.status('kanban')).toEqual({ state: 'off' })
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'off' })
    })

    it('stops and starts an extension at once when it is switched with a graph open, telling listeners', async () => {
        const { host, graph, kanbanActivate } = setUp()
        await host.start(graph.services)
        const listener = vi.fn()
        host.subscribe(listener)
        host.setOn('kanban', false)
        expect(host.isOn('kanban')).toBe(false)
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'off' })
        await host.setOn('kanban', true)
        expect(kanbanActivate).toHaveBeenCalledTimes(2)
        expect(slotOf(host, 'kanban.board').state()).toEqual({ status: 'ready', view })
        expect(listener).toHaveBeenCalled()
    })

    it('tries a failed extension again on request, fetching its bundle afresh', async () => {
        let attempt = 0
        const graphViewActivate = vi.fn((context: ExtensionContext) => {
            context.views.register('graph-view.whole', view)
            context.views.register('graph-view.local', view)
        })
        const { host, graph, importModule } = setUp({
            importModule: async () => {
                attempt += 1
                if (attempt === 1) throw new Error('offline')
                return { activate: graphViewActivate }
            },
        })
        await host.start(graph.services)
        expect(host.status('graph-view')).toEqual({ state: 'failed', message: 'offline' })
        await host.retry('graph-view')
        expect(importModule).toHaveBeenCalledTimes(2)
        expect(host.status('graph-view')).toEqual({ state: 'running' })
        expect(slotOf(host, 'graph-view.whole').state()).toEqual({ status: 'ready', view })
    })

    it('imports a loaded extension once, however many graphs open', async () => {
        const { host, graph, importModule, graphViewActivate } = setUp()
        await host.start(graph.services)
        host.stop()
        await host.start(fakeGraphServices('g2').services)
        expect(importModule).toHaveBeenCalledTimes(1)
        expect(graphViewActivate).toHaveBeenCalledTimes(2)
    })

    it('does not start a loaded extension whose bundle arrives after its graph closed', async () => {
        let arrive: (module: unknown) => void = () => {}
        const graphViewActivate = vi.fn()
        const { host, graph } = setUp({ importModule: () => new Promise((resolve) => (arrive = resolve)) })
        const started = host.start(graph.services)
        host.stop()
        arrive({ activate: graphViewActivate })
        await started
        expect(graphViewActivate).not.toHaveBeenCalled()
        expect(host.status('graph-view')).toEqual({ state: 'idle' })
    })

    it('lists a broken package with its reasons', () => {
        const { host } = setUp()
        expect(host.catalogue.broken).toEqual([])
    })
})
