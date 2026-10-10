import { describe, expect, it, vi } from 'vitest'

import type { ExtensionPackage, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { commandMenuItemsInOrder } from '$lib/surface/command-menu'
import { listContextMenuItems } from '$lib/surface/context-menu'
import { graphSidebarButtons } from '$lib/surface/graph-sidebar-buttons'

import { createPersonSettings } from '$lib/person-settings/person-settings'

import type { CatalogueEntry } from './catalogue'
import { createScopedContext } from './scoped-context'
import { fakeClientServices, fakeGraphServices, memoryStorage } from './testing'

const graphView: ExtensionPackage = {
    name: '@appsoftwareltd/etherpk-extension-graph-view',
    version: '0.8.54',
    manifest: {
        id: 'graph-view',
        displayName: 'Graph View',
        publisher: 'App Software',
        main: './dist/main.js',
        icons: { 'graph-view': '<circle cx="8" cy="8" r="2"/>' },
        views: [{ kind: 'graph-view.whole', target: 'whole', title: 'Whole graph', region: 'main', address: { segment: 'graph-view' } }],
        settings: [
            { id: 'depth', type: 'text', title: 'Depth' },
            { id: 'labels', type: 'boolean', title: 'Show labels', default: true },
            { id: 'clusters', type: 'boolean', title: 'Show clusters' },
        ],
    },
}

function setUp() {
    const entry: CatalogueEntry = { id: 'graph-view', package: graphView, source: 'loaded', base: '/extensions/graph-view/0.8.54/' }
    const { services, bindings, indexListeners } = fakeGraphServices()
    const storage = memoryStorage()
    const settings = createPersonSettings(() => memoryStorage())
    const supplied = new Map<string, ViewContribution>()
    const supplyView = (kind: string, view: ViewContribution) => {
        supplied.set(kind, view)
        return () => void supplied.delete(kind)
    }
    const scoped = createScopedContext(entry, services, fakeClientServices(storage, settings), supplyView)
    const { commands, contributions, events } = services
    return { scoped, context: scoped.context, commands, contributions, events, bindings, indexListeners, storage, settings, supplied }
}

describe('an extension context', () => {
    it("says which extension, graph and Client it belongs to", () => {
        const { context } = setUp()
        expect([context.extensionId, context.graphId, context.clientVersion, context.dev]).toEqual(['graph-view', 'g1', '0.8.54', false])
    })

    it("takes Commands only under the extension's own id", async () => {
        const { context, commands } = setUp()
        const handler = vi.fn(() => 'done')
        context.commands.register('graph-view.reveal', handler)
        expect(await commands.execute('graph-view.reveal', 1)).toBe('done')
        expect(() => context.commands.register('reveal', handler)).toThrow('Command "reveal" must start with "graph-view."')
        expect(() => context.commands.register('kanban.reveal', handler)).toThrow('Command "kanban.reveal" must start with "graph-view."')
    })

    it("runs any Command, the Client's included", async () => {
        const { context, commands } = setUp()
        commands.register('layout.toggleSidebar', () => 'toggled')
        expect(context.commands.has('layout.toggleSidebar')).toBe(true)
        expect(await context.commands.execute('layout.toggleSidebar')).toBe('toggled')
    })

    it('supplies a View only for a kind the manifest declares', () => {
        const { context, supplied } = setUp()
        const view: ViewContribution = { mount: () => ({ destroy() {} }) }
        context.views.register('graph-view.whole', view)
        expect(supplied.get('graph-view.whole')).toBe(view)
        expect(() => context.views.register('graph-view.local', view)).toThrow('View kind "graph-view.local" is not declared in the manifest.')
    })

    it('adds Context Menu and Command Menu rows under its id, with its own icons named under it too', () => {
        const { context, contributions } = setUp()
        context.contextMenu.register({ id: 'graph-view.showConcept', label: 'Show in Graph View', command: 'graph-view.showConcept', icon: 'graph-view' })
        context.commandMenu.register({ id: 'graph-view.insert', title: 'Graph', command: 'graph-view.openWhole', icon: 'link' })
        expect(listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Home' })).toEqual([
            { id: 'graph-view.showConcept', label: 'Show in Graph View', command: 'graph-view.showConcept', icon: 'graph-view.graph-view', separatorBefore: false },
        ])
        expect(commandMenuItemsInOrder(contributions).map((item) => [item.id, item.icon])).toEqual([['graph-view.insert', 'link']])
        expect(() => context.contextMenu.register({ id: 'show', label: 'Show', command: 'graph-view.showConcept' })).toThrow('Context Menu row "show" must start with "graph-view."')
    })

    it('adds Graph Sidebar buttons under its id, with its own icons named under it, and takes them back when disposed', () => {
        const { scoped, context, contributions } = setUp()
        context.graphSidebar.register({ id: 'graph-view.openWhole', title: 'Graph View', command: 'graph-view.openWhole', icon: 'graph-view' })
        expect(graphSidebarButtons(contributions).map((button) => [button.id, button.title, button.icon])).toEqual([['graph-view.openWhole', 'Graph View', 'graph-view.graph-view']])
        expect(() => context.graphSidebar.register({ id: 'open', title: 'Open', command: 'graph-view.openWhole' })).toThrow('Graph Sidebar button "open" must start with "graph-view."')
        scoped.dispose()
        expect(graphSidebarButtons(contributions)).toEqual([])
    })

    it("draws its own icon before one of the Client's with the same name", () => {
        const { context } = setUp()
        expect(context.icons.svg('graph-view')).toBe('<svg data-icon="graph-view.graph-view"/>')
        expect(context.icons.svg('close')).toBe('<svg data-icon="close"/>')
    })

    it('binds a chord no one else binds', () => {
        const { context, bindings } = setUp()
        context.keybindings.register({ key: 'Alt+M', command: 'graph-view.reveal', label: 'Graph View' })
        expect(bindings.map((binding) => binding.key)).toEqual(['Alt+J', 'Alt+M'])
        expect(() => context.keybindings.register({ key: 'Alt+J', command: 'graph-view.reveal', label: 'Graph View' })).toThrow('Alt+J is bound already.')
    })

    it('listens to the Events an extension may hear, and refuses the rest', () => {
        const { context, events } = setUp()
        const listener = vi.fn()
        context.events.on('document:active-changed', listener)
        events.emit('document:active-changed', { documentId: 'Home' })
        expect(listener).toHaveBeenCalledWith({ graphId: 'g1', documentId: 'Home' })
        expect(() => context.events.on('quick-notes:focus' as never, listener)).toThrow('Extensions cannot listen to "quick-notes:focus".')
    })

    it('keeps its values under its own key prefix on this device, as JSON', () => {
        const { context, storage } = setUp()
        context.storage.set('whole', { depth: 2 })
        expect(storage.getItem('etherpk-graph-view:whole')).toBe('{"depth":2}')
        expect(context.storage.get('whole')).toEqual({ depth: 2 })
        storage.setItem('etherpk-graph-view:broken', '{oops')
        expect(context.storage.get('broken')).toBeUndefined()
        context.storage.remove('whole')
        expect(context.storage.get('whole')).toBeUndefined()
    })

    it("reads the person's answers to its own settings only, and hears them change until disposed", () => {
        const { scoped, context, settings } = setUp()
        const heard = vi.fn()
        context.settings.subscribe(heard)
        settings.set('extension.graph-view.depth', '3')
        settings.set('extension.kanban.depth', '9')
        expect(context.settings.get('depth')).toBe('3')
        expect(context.settings.get('colour')).toBeUndefined()
        expect(heard).toHaveBeenCalledTimes(2)
        scoped.dispose()
        settings.set('extension.graph-view.depth', '4')
        expect(heard).toHaveBeenCalledTimes(2)
        context.settings.subscribe(heard)
        settings.set('extension.graph-view.depth', '5')
        expect(heard).toHaveBeenCalledTimes(2)
    })

    it("reads a switch as 'true' or 'false', its manifest's default until the person sets it", () => {
        const { context, settings } = setUp()
        expect(context.settings.get('labels')).toBe('true')
        expect(context.settings.get('clusters')).toBe('false')
        settings.set('extension.graph-view.labels', 'false')
        expect(context.settings.get('labels')).toBe('false')
        // Anything else stored for a switch reads as its default.
        settings.set('extension.graph-view.clusters', 'maybe')
        expect(context.settings.get('clusters')).toBe('false')
    })

    it('takes back everything it added when disposed, and adds nothing after', () => {
        const { scoped, context, commands, contributions, events, bindings, indexListeners, supplied } = setUp()
        const listener = vi.fn()
        context.commands.register('graph-view.reveal', () => {})
        context.contextMenu.register({ id: 'graph-view.showConcept', label: 'Show', command: 'graph-view.reveal' })
        context.contributions.register('augmentation-renderer', 'dot', { render: () => null })
        context.keybindings.register({ key: 'Alt+M', command: 'graph-view.reveal', label: 'Graph View' })
        context.events.on('documents:changed', listener)
        context.index.onUpdated(listener)
        context.views.register('graph-view.whole', { mount: () => ({ destroy() {} }) })

        scoped.dispose()

        expect(commands.has('graph-view.reveal')).toBe(false)
        expect(contributions.list('context-menu')).toEqual([])
        expect(contributions.has('augmentation-renderer', 'dot')).toBe(false)
        expect(bindings.map((binding) => binding.key)).toEqual(['Alt+J'])
        events.emit('documents:changed', {})
        expect(listener).not.toHaveBeenCalled()
        expect(indexListeners.size).toBe(0)
        expect(supplied.size).toBe(0)

        context.commands.register('graph-view.late', () => {})
        expect(commands.has('graph-view.late')).toBe(false)
    })

    it("lets an extension remove one of its own contributions, and no one else's", () => {
        const { context, contributions } = setUp()
        contributions.register('augmentation-renderer', 'math', { render: () => null })
        context.contributions.register('augmentation-renderer', 'dot', { render: () => null })
        context.contributions.unregister('augmentation-renderer', 'math')
        context.contributions.unregister('augmentation-renderer', 'dot')
        expect(contributions.has('augmentation-renderer', 'math')).toBe(true)
        expect(contributions.has('augmentation-renderer', 'dot')).toBe(false)
    })
})
