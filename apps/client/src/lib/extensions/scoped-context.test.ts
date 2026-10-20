import { describe, expect, it, vi } from 'vitest'

import type { ExtensionContext, ExtensionPackage, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { commandMenuItemsInOrder } from '$lib/surface/command-menu'
import { listContextMenuItems } from '$lib/surface/context-menu'
import { graphSidebarButtons } from '$lib/surface/graph-sidebar-buttons'
import { listJournalPanels } from '$lib/surface/journal-panels'

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

/**
 * An extension's context. `installed` makes it a release from the Extension Directory, and
 * `sideLoaded` a dev folder holding no built-in, rather than a built-in.
 */
function setUp({ installed = false, sideLoaded = false } = {}) {
    const entry: CatalogueEntry = {
        id: 'graph-view',
        package: graphView,
        source: 'loaded',
        base: '/extensions/graph-view/0.8.54/',
        installed: installed ? { version: '0.8.54', integrity: `sha512-${'A'.repeat(86)}==` } : undefined,
        builtIn: !installed && !sideLoaded,
    }
    const { services, bindings, indexListeners } = fakeGraphServices()
    const storage = memoryStorage()
    const settings = createPersonSettings(() => memoryStorage())
    const supplied = new Map<string, ViewContribution>()
    const supplyView = (kind: string, view: ViewContribution) => {
        supplied.set(kind, view)
        return () => void supplied.delete(kind)
    }
    const client = fakeClientServices(storage, settings)
    const scoped = createScopedContext(entry, services, client, supplyView, () => ['graph-view', 'kanban'])
    const { commands, contributions, events } = services
    return { scoped, context: scoped.context, client, services, commands, contributions, events, bindings, indexListeners, storage, settings, supplied }
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
            { id: 'graph-view.showConcept', label: 'Show in Graph View', command: 'graph-view.showConcept', icon: 'graph-view.graph-view', separatorBefore: false, danger: false },
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

    it('passes a Graph Sidebar button’s help text and its when through to the Sidebar', () => {
        const { context, contributions } = setUp()
        let desktop = true
        context.graphSidebar.register({
            id: 'graph-view.openWhole',
            title: 'Graph View',
            description: 'Open a graph of every page and link',
            when: () => desktop,
            command: 'graph-view.openWhole',
        })
        expect(graphSidebarButtons(contributions).map((button) => button.description)).toEqual(['Open a graph of every page and link'])
        desktop = false
        expect(graphSidebarButtons(contributions)).toEqual([])
    })

    it("draws its own icon before one of the Client's with the same name", () => {
        const { context } = setUp()
        expect(context.icons.svg('graph-view')).toBe('<svg data-icon="graph-view.graph-view"/>')
        expect(context.icons.svg('close')).toBe('<svg data-icon="close"/>')
    })

    it('binds a chord no one else binds, and leaves one bound already to whoever bound it', () => {
        const { context, bindings } = setUp()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        context.keybindings.register({ key: 'Alt+M', command: 'graph-view.reveal', label: 'Graph View' })
        expect(bindings.map((binding) => binding.key)).toEqual(['Alt+J', 'Alt+M'])
        // A chord the Client binds already, perhaps one it added in a later release: the extension still starts.
        expect(() => context.keybindings.register({ key: 'Alt+J', command: 'graph-view.reveal', label: 'Graph View' })).not.toThrow()
        expect(bindings.map((binding) => [binding.key, binding.command])).toEqual([
            ['Alt+J', 'document.openTodayJournal'],
            ['Alt+M', 'graph-view.reveal'],
        ])
        expect(warn).toHaveBeenCalledWith('[extensions] graph-view: Alt+J is not bound to graph-view.reveal', expect.any(Error))
        warn.mockRestore()
    })

    it("binds a chord to the extension's own Command only", () => {
        const { context, bindings } = setUp()
        expect(() => context.keybindings.register({ key: 'Alt+K', command: 'kanban.open', label: 'Kanban' })).toThrow('The chord Alt+K\'s Command "kanban.open" must start with "graph-view."')
        expect(bindings.map((binding) => binding.key)).toEqual(['Alt+J'])
    })

    it('brings forward its own Sidebar residents, and no other kind', () => {
        const { context, services } = setUp()
        context.layout.reveal('graph-view.whole')
        context.layout.reveal('agent-chat.chats')
        expect(services.layout.reveal).toHaveBeenCalledTimes(1)
        expect(services.layout.reveal).toHaveBeenCalledWith('graph-view.whole')
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

describe("an extension's editor, dialogs and frames", () => {
    const widget = { height: () => 200, mount: () => ({ update: () => {}, destroy: () => {} }) }

    it('draws fences named by its id, or by a name under it, and no other', () => {
        const { context, contributions } = setUp()
        context.editor.registerFence('graph-view', widget)
        context.editor.registerFence('graph-view.plan', widget, { keepsHistory: true, identify: () => 'k1' })
        expect(contributions.has('interactive-fence', 'graph-view')).toBe(true)
        const plan = contributions.get('interactive-fence', 'graph-view.plan') as { keepsHistory?: boolean; identify?: (body: string[]) => string | null }
        expect(plan.keepsHistory).toBe(true)
        expect(plan.identify?.([])).toBe('k1')
        for (const info of ['map', 'kanban.board', 'graph-view.Plan', 'graph-view.', 'graph-viewer']) {
            expect(() => context.editor.registerFence(info, widget)).toThrow(/info word must be/)
        }
    })

    it("tells its fences' quotes when its own settings change, and not when another's do", () => {
        const { context, contributions, settings } = setUp()
        context.editor.registerFence('graph-view.plan', widget, { quote: () => null })
        context.editor.registerFence('graph-view', widget)
        const plan = contributions.get('interactive-fence', 'graph-view.plan') as { quotesChanged?(listener: () => void): () => void }
        const heard = vi.fn()
        plan.quotesChanged?.(heard)
        settings.set('extension.kanban.lanes', '3')
        expect(heard).not.toHaveBeenCalled()
        context.settings.set('labels', 'false')
        expect(heard).toHaveBeenCalledTimes(1)
        // A fence with no quote has nothing to be told.
        expect((contributions.get('interactive-fence', 'graph-view') as { quotesChanged?: unknown }).quotesChanged).toBeUndefined()
    })

    it('takes its fences back when it stops', () => {
        const { scoped, context, contributions } = setUp()
        context.editor.registerFence('graph-view.plan', widget)
        scoped.dispose()
        expect(contributions.has('interactive-fence', 'graph-view.plan')).toBe(false)
    })

    it('puts a block at the caret through the workspace, and nothing once stopped', () => {
        const { scoped, context } = setUp()
        expect(context.editor.insertBlock('```graph-view.plan\n```', { focus: true })).toBe(true)
        scoped.dispose()
        expect(context.editor.insertBlock('```graph-view.plan\n```')).toBe(false)
    })

    it('opens a panel in the document through the workspace, and closes it when stopped', () => {
        const { scoped, context, services } = setUp()
        const panel = { document: 'Garden', isOpen: true, insertBlock: vi.fn(), focus: vi.fn(), resize: vi.fn(), outline: vi.fn(() => null), lineText: vi.fn(() => null), close: vi.fn() }
        vi.mocked(services.editor.openPanel).mockReturnValue(panel)
        expect(context.editor.openPanel({ mount: () => ({ destroy() {} }) })).toBe(panel)
        scoped.dispose()
        expect(panel.close).toHaveBeenCalledOnce()
        expect(context.editor.openPanel({ mount: () => ({ destroy() {} }) })).toBeNull()
    })

    it('opens a window over the Client, closes it when stopped, and opens none after', () => {
        const { scoped, context, services } = setUp()
        const opened = { close: vi.fn() }
        vi.mocked(services.layout.openWindow).mockReturnValue(opened)
        context.layout.openWindow({ title: 'Plan', mount: () => ({ destroy() {} }) })
        scoped.dispose()
        expect(opened.close).toHaveBeenCalledOnce()
        context.layout.openWindow({ title: 'Plan', mount: () => ({ destroy() {} }) })
        expect(services.layout.openWindow).toHaveBeenCalledOnce()
    })

    it("keeps its records for the open graph apart from another extension's", async () => {
        const { context, services } = setUp()
        await context.records.set('chat:a', { title: 'Beans' })
        expect(await services.records('kanban').keys()).toEqual([])
        expect(await context.records.get('chat:a')).toEqual({ title: 'Beans' })
    })

    it('asks its questions in a dialog that names it', async () => {
        const { context, client } = setUp()
        await context.dialogs.prompt({ title: 'New bed', label: 'Name' })
        expect(client.dialogs.prompt).toHaveBeenCalledWith({ title: 'New bed', label: 'Name' }, 'Graph View')
    })

    it('names the hosts a frame may show, and refuses any other', () => {
        const { context } = setUp()
        expect(context.embeds.frameHosts).toEqual(['https://www.youtube-nocookie.com', 'https://player.vimeo.com'])
        expect(() => context.embeds.frame({ src: 'https://example.com/', title: 'Garden' })).toThrow(/only from/)
    })
})

describe('an extension from the Extension Directory', () => {
    const widget = { height: () => 200, mount: () => ({ update: () => {}, destroy: () => {} }) }

    it('uses the Stable part of the API', async () => {
        const { context, commands, contributions, supplied } = setUp({ installed: true })
        context.commands.register('graph-view.reveal', () => 'done')
        expect(await commands.execute('graph-view.reveal')).toBe('done')
        context.commandMenu.register({ id: 'graph-view.insert', title: 'Graph', command: 'graph-view.reveal' })
        expect(commandMenuItemsInOrder(contributions).map((item) => item.id)).toEqual(['graph-view.insert'])
        context.views.register('graph-view.whole', { mount: () => ({ destroy() {} }) })
        expect(supplied.has('graph-view.whole')).toBe(true)
        context.editor.registerFence('graph-view.plan', widget)
        expect(contributions.has('interactive-fence', 'graph-view.plan')).toBe(true)
        context.storage.set('whole', 1)
        expect([context.storage.get('whole'), context.settings.get('labels'), context.layout.isDesktop()]).toEqual([1, 'true', true])
    })

    // Made Stable in 0.11.0, for the first extension that needed them from the directory (ADR 0120,
    // amended 2026-10-12): a Graph Sidebar button, opening a day's Journal Entry, and the theme.
    it('adds Graph Sidebar buttons, opens documents, and follows the theme', () => {
        const { context, contributions, events, services } = setUp({ installed: true })
        context.graphSidebar.register({ id: 'graph-view.openWhole', title: 'Graph View', command: 'graph-view.openWhole' })
        expect(graphSidebarButtons(contributions).map((button) => button.id)).toEqual(['graph-view.openWhole'])
        context.layout.openDocument('2026-10-12')
        expect(services.layout.openDocument).toHaveBeenCalledWith('2026-10-12')
        expect(context.theme.isDark()).toBe(false)
        const heard = vi.fn()
        context.events.on('theme:changed', heard)
        events.emit('theme:changed', { dark: true })
        expect(heard).toHaveBeenCalledWith({ graphId: 'g1', dark: true })
    })

    it('uses the parts added for 0.11.0: setting its settings, its records kept with the person, signing in and Journal Panels', async () => {
        const { context, contributions } = setUp({ installed: true })
        context.settings.set('depth', '3')
        expect(context.settings.get('depth')).toBe('3')
        context.personStorage.set('accounts', ['gardener@example.com'])
        expect(context.personStorage.get('accounts')).toEqual(['gardener@example.com'])
        await expect(context.auth.authorize('https://accounts.example/auth?state=s1')).resolves.toEqual({ code: 'c1', state: 's1' })
        context.journalPanels.register({ id: 'graph-view.day', mount: () => ({ destroy() {} }) })
        expect(contributions.has('journal-panel', 'graph-view.day')).toBe(true)
    })

    // Everything is Stable since 0.14.0 but `contributions` (ADR 0120, amended 2026-10-17). Through
    // it an extension could take any kind's entries, another extension's fence word among them.
    it.each<[string, (context: ExtensionContext) => unknown]>([
        ['contributions.register', (context) => context.contributions.register('interactive-fence', 'map', {})],
        ['contributions.list', (context) => context.contributions.list('context-menu')],
        ['contributions.get', (context) => context.contributions.get('interactive-fence', 'map')],
    ])('cannot use the Proposed %s', (member, use) => {
        const { context, contributions } = setUp({ installed: true })
        expect(() => use(context)).toThrow(`context.${member} is in the Proposed part of the Extension API, which only the extensions that come with EtherPK may use.`)
        expect(contributions.has('interactive-fence', 'map')).toBe(false)
    })

    it("cannot read the text of an inline panel's line, which is Proposed, and keeps every Stable part of the panel", () => {
        const opened = { document: 'Garden', isOpen: true, insertBlock: vi.fn(() => true), focus: vi.fn(), resize: vi.fn(), outline: vi.fn(() => '- water'), lineText: vi.fn(() => 'water the beans'), close: vi.fn() }
        const installed = setUp({ installed: true })
        let mounted: unknown = null
        vi.mocked(installed.services.editor.openPanel).mockImplementation((options) => {
            options.mount({} as HTMLElement, opened)
            return opened
        })
        const panel = installed.context.editor.openPanel({ mount: (_host, given) => ((mounted = given), { destroy() {} }) })!
        // The panel the mount is given is the one openPanel returns, so the extension knows it.
        expect(mounted).toBe(panel)
        expect(() => panel.lineText()).toThrow('context.editor.openPanel().lineText is in the Proposed part of the Extension API')
        expect([panel.document, panel.isOpen, panel.insertBlock('- a'), panel.outline()]).toEqual(['Garden', true, true, '- water'])

        const builtIn = setUp()
        vi.mocked(builtIn.services.editor.openPanel).mockReturnValue(opened)
        expect(builtIn.context.editor.openPanel({ mount: () => ({ destroy() {} }) })!.lineText()).toBe('water the beans')
    })

    it('uses the parts made Stable in 0.14.0', async () => {
        const { context, contributions, bindings, services } = setUp({ installed: true })
        context.commands.register('graph-view.reveal', () => 'revealed')
        context.contextMenu.register({ id: 'graph-view.show', label: 'Show', command: 'graph-view.reveal', danger: true })
        expect(listContextMenuItems(contributions, { kind: 'document-tab', concept: 'Garden' }).map((row) => [row.id, row.danger])).toEqual([['graph-view.show', true]])
        context.commandBar.register({ id: 'graph-view.bar', title: 'Graph', icon: 'graph-view', command: 'graph-view.reveal' })
        context.keybindings.register({ key: 'Alt+M', command: 'graph-view.reveal', label: 'Graph View' })
        expect(bindings.map((binding) => binding.key)).toEqual(['Alt+J', 'Alt+M'])
        expect([context.index.allConcepts(), context.concepts.key('Garden'), context.icons.svg('close')]).toEqual([[], 'garden', '<svg data-icon="close"/>'])
        expect(context.layout.activeDocument()).toBeNull()
        context.layout.reveal('graph-view.whole')
        expect(services.layout.reveal).toHaveBeenCalledWith('graph-view.whole')
        await expect(context.records.keys()).resolves.toEqual([])
    })

    it("runs its own Commands, another extension's, and the Client's that CLIENT_COMMANDS names, and no other", async () => {
        const { context, commands } = setUp({ installed: true })
        commands.register('graph-view.reveal', () => 'own')
        commands.register('kanban.open', () => 'another extension')
        commands.register('agents.settings', () => 'listed')
        commands.register('layout.toggleSidebar', () => 'unlisted')
        expect(await context.commands.execute('graph-view.reveal')).toBe('own')
        expect(await context.commands.execute('kanban.open')).toBe('another extension')
        expect(await context.commands.execute('agents.settings')).toBe('listed')
        await expect(context.commands.execute('layout.toggleSidebar')).rejects.toThrow('runs "layout.toggleSidebar", a Command of the Client that extensions may not run.')
        expect([context.commands.has('agents.settings'), context.commands.has('layout.toggleSidebar')]).toEqual([true, false])
    })

    it('adds no menu row or button for a Command of the Client that extensions may not run', () => {
        const { context, contributions } = setUp({ installed: true })
        expect(() => context.commandMenu.register({ id: 'graph-view.toggle', title: 'Toggle', command: 'layout.toggleSidebar' })).toThrow(
            'Command Menu row "graph-view.toggle" runs "layout.toggleSidebar"',
        )
        expect(() => context.graphSidebar.register({ id: 'graph-view.toggle', title: 'Toggle', command: 'layout.toggleSidebar' })).toThrow(/Graph Sidebar button/)
        expect(() => context.contextMenu.register({ id: 'graph-view.toggle', label: 'Toggle', command: 'layout.toggleSidebar' })).toThrow(/Context Menu row/)
        expect(() => context.commandBar.register({ id: 'graph-view.toggle', title: 'Toggle', icon: 'close', command: 'layout.toggleSidebar' })).toThrow(/Command Bar button/)
        expect(commandMenuItemsInOrder(contributions)).toEqual([])
        context.graphSidebar.register({ id: 'graph-view.settings', title: 'Agents', command: 'agents.settings' })
        expect(graphSidebarButtons(contributions).map((button) => button.id)).toEqual(['graph-view.settings'])
    })
})

describe('an extension side-loaded while it is written', () => {
    // So its author meets the Stable API's limits while testing, not after a Directory install.
    it('gets what a Directory release gets', async () => {
        const { context, commands } = setUp({ sideLoaded: true })
        expect(() => context.contributions.list('context-menu')).toThrow('context.contributions.list is in the Proposed part')
        commands.register('layout.toggleSidebar', () => 'unlisted')
        await expect(context.commands.execute('layout.toggleSidebar')).rejects.toThrow(/may not run/)
    })
})

describe("an extension's settings", () => {
    it('sets a setting its manifest declares, as the person would, and clears it with null or empty text', () => {
        const { context, settings } = setUp()
        const heard = vi.fn()
        context.settings.subscribe(heard)
        context.settings.set('depth', '3')
        expect([context.settings.get('depth'), settings.get('extension.graph-view.depth')]).toEqual(['3', '3'])
        expect(heard).toHaveBeenCalled()
        context.settings.set('depth', null)
        expect(context.settings.get('depth')).toBeUndefined()
        context.settings.set('depth', '4')
        context.settings.set('depth', '')
        expect(context.settings.get('depth')).toBeUndefined()
    })

    it('sets a switch only on or off', () => {
        const { context } = setUp()
        context.settings.set('labels', 'false')
        expect(context.settings.get('labels')).toBe('false')
        expect(() => context.settings.set('labels', 'maybe')).toThrow('The setting "labels" is a switch: set it to "true" or "false".')
        expect(context.settings.get('labels')).toBe('false')
    })

    it('refuses a setting its manifest does not declare, so it never writes another extension’s', () => {
        const { context, settings } = setUp()
        expect(() => context.settings.set('colour', 'red')).toThrow('The setting "colour" is not declared in the manifest of graph-view.')
        expect(() => context.settings.set('../kanban.token', 'x')).toThrow(/not declared/)
        expect(settings.keys('extension.')).toEqual([])
    })
})

describe("an extension's records kept with the person", () => {
    it('keeps each record as JSON under the extension’s id, beside its settings, and forgets it when removed', () => {
        const { context, settings } = setUp()
        context.personStorage.set('accounts', [{ email: 'gardener@example.com', added: 1 }])
        expect(context.personStorage.get('accounts')).toEqual([{ email: 'gardener@example.com', added: 1 }])
        expect(settings.get('extension-data.graph-view.accounts')).toBe('[{"email":"gardener@example.com","added":1}]')
        context.personStorage.remove('accounts')
        expect(context.personStorage.get('accounts')).toBeUndefined()
        context.personStorage.set('accounts', 'x')
        context.personStorage.set('accounts', null)
        expect(context.personStorage.get('accounts')).toBeUndefined()
        context.personStorage.set('accounts', undefined)
        expect(settings.keys('extension-data.')).toEqual([])
    })

    it('keeps a string with spaces at its ends as it was given', () => {
        const { context } = setUp()
        context.personStorage.set('note', '  beans  ')
        expect(context.personStorage.get('note')).toBe('  beans  ')
    })

    it('refuses a key it could not keep and a record over 64 KB', () => {
        const { context } = setUp()
        expect(() => context.personStorage.set('', 1)).toThrow('A record\'s key is letters, digits, ".", "_" and "-", at most 100 of them, not "".')
        expect(() => context.personStorage.set('beds/north', 1)).toThrow(/not "beds\/north"/)
        expect(() => context.personStorage.set('beds', 'x'.repeat(64 * 1024))).toThrow('The record "beds" is longer than 64 KB as JSON.')
        expect(context.personStorage.get('beds')).toBeUndefined()
    })

    it('reads nothing from a record that is not JSON', () => {
        const { context, settings } = setUp()
        settings.set('extension-data.graph-view.broken', '{"email":')
        expect(context.personStorage.get('broken')).toBeUndefined()
    })

    it('tells a listener when one of its own records changes, here or from another device, and not for anything else', () => {
        const { scoped, context, settings } = setUp()
        const heard = vi.fn()
        context.personStorage.subscribe(heard)
        context.personStorage.set('accounts', ['gardener@example.com'])
        expect(heard).toHaveBeenCalledTimes(1)
        settings.set('extension-data.kanban.lanes', '3')
        settings.set('extension.graph-view.depth', '3')
        expect(heard).toHaveBeenCalledTimes(1)
        settings.merge('https://sync.example a1', { 'extension-data.graph-view.accounts': { value: '["orchard@example.com"]', changedAt: Date.now() + 1000 } })
        expect(heard).toHaveBeenCalledTimes(2)
        expect(context.personStorage.get('accounts')).toEqual(['orchard@example.com'])
        scoped.dispose()
        context.personStorage.set('accounts', [])
        expect(heard).toHaveBeenCalledTimes(2)
    })
})

describe('signing in from an extension', () => {
    it("names the Client's return address and passes a sign-in through to the Client", async () => {
        const { context, client } = setUp()
        expect(context.auth.redirectUri).toBe('https://client.example/extension-sign-in')
        const controller = new AbortController()
        await expect(context.auth.authorize('https://accounts.example/auth?state=s1', { signal: controller.signal })).resolves.toEqual({ code: 'c1', state: 's1' })
        expect(client.signIn.authorize).toHaveBeenCalledWith('https://accounts.example/auth?state=s1', { signal: controller.signal })
    })

    it('starts no sign-in once stopped', async () => {
        const { scoped, context, client } = setUp()
        scoped.dispose()
        await expect(context.auth.authorize('https://accounts.example/auth?state=s1')).rejects.toThrow('Graph View was stopped.')
        expect(client.signIn.authorize).not.toHaveBeenCalled()
    })
})

describe("an extension's Journal Panels", () => {
    it('adds a panel under its id, and takes it back when disposed', () => {
        const { scoped, context, contributions } = setUp()
        context.journalPanels.register({ id: 'graph-view.day', mount: () => ({ destroy() {} }) })
        expect(listJournalPanels(contributions).map((panel) => panel.id)).toEqual(['graph-view.day'])
        expect(() => context.journalPanels.register({ id: 'day', mount: () => ({ destroy() {} }) })).toThrow('Journal Panel "day" must start with "graph-view."')
        scoped.dispose()
        expect(listJournalPanels(contributions)).toEqual([])
    })

    it("mounts a loaded extension's panel in a shadow root that holds its stylesheets", () => {
        const { context, contributions } = setUp()
        context.journalPanels.register({ id: 'graph-view.day', mount: () => ({ destroy() {} }) })
        expect(listJournalPanels(contributions)[0].isolation).toEqual({ styles: [] })
    })
})
