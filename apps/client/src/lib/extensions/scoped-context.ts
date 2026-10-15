/**
 * One extension's context for one open graph (ADR 0121): the published {@link ExtensionContext},
 * built over the workspace's own registries, and scoped to the extension.
 *
 * Scoped means three things:
 *
 * - **Names.** A Command, a Context Menu row, a Command Menu row and a Graph Sidebar button must
 *   sit under the extension's id, so two extensions can never take each other's names. An icon the manifest
 *   gives is registered under the id too, and a row that names it is pointed at that.
 * - **Clean-up.** Everything added through the context is remembered and taken back by
 *   `dispose`, which the host calls when the graph closes or the extension is switched off. An
 *   extension never has to undo its own registrations, and one that forgets cannot leave a dead
 *   Command behind.
 * - **Reach.** Only the Events the API names can be heard, and nothing here leads to a document
 *   store, a key or a sync engine. An extension from the Extension Directory reaches only the API's
 *   Stable part (`stableOnly`): the Proposed part is for the extensions that come with EtherPK.
 *
 * After `dispose` the context adds nothing: a callback that fires late does no harm.
 */
import type {
    CommandBarButton,
    CommandMenuItem,
    ContextMenuItem,
    ExtensionContext,
    ExtensionContributions,
    ExtensionEventName,
    ExtensionEventPayloads,
    GraphSidebarButton,
    IconMarkup,
    ViewContribution,
} from '@appsoftwareltd/etherpk-extension-api'

import { PLAYER_FRAME_HOSTS } from '@appsoftwareltd/etherpk-shared/frame-hosts'

import { INTERACTIVE_FENCE_KIND } from '$lib/document/view/augmentations/interactive-fence-contract'
import { extensionSettingKey } from '$lib/person-settings/person-settings'
import { registerCommandBarItem } from '$lib/surface/command-bar'
import { registerCommandMenuItem, type CommandMenuItem as ClientCommandMenuItem } from '$lib/surface/command-menu'
import { registerContextMenuItem, type ContextMenuItem as ClientContextMenuItem } from '$lib/surface/context-menu'
import { registerGraphSidebarButton } from '$lib/surface/graph-sidebar-buttons'
import { registerJournalPanel } from '$lib/surface/journal-panels'
import type { EventName } from '$lib/surface'

import type { CatalogueEntry } from './catalogue'
import { toInteractiveFence } from './fence-widgets'
import { buildFrame } from './frames'
import { type ContextLifecycle, extensionPersonStorage, extensionSettings } from './person-scoped'
import type { ClientServices, GraphServices } from './services'

/** An extension's id or a name under it, as a fence's info word may take them. */
const FENCE_NAME = /^[a-z][a-z0-9-]*$/

export { RECORD_LIMIT } from './person-scoped'

/** The Events an extension may hear: the API's catalogue, and no other of the Client's. */
export const EXTENSION_EVENTS: readonly ExtensionEventName[] = ['document:active-changed', 'concept:renamed', 'document:deleted', 'documents:changed', 'theme:changed']

export interface ScopedContext {
    context: ExtensionContext
    /** Take back everything the extension added. Idempotent. */
    dispose(): void
}

const noop = () => {}

export function createScopedContext(
    entry: CatalogueEntry,
    graph: GraphServices,
    client: ClientServices,
    supplyView: (kind: string, view: ViewContribution) => () => void,
): ScopedContext {
    const id = entry.id
    const manifest = entry.package.manifest
    const declaredKinds = new Set((manifest.views ?? []).map((view) => view.kind))
    const ownIcons = new Set(Object.keys(manifest.icons ?? {}))
    const disposers: (() => void)[] = []
    let disposed = false

    /** Keep a registration's undo, or undo it at once when the context is already disposed. */
    const keep = (undo: () => void): (() => void) => {
        if (disposed) {
            undo()
            return noop
        }
        let done = false
        const once = () => {
            if (done) return
            done = true
            undo()
        }
        disposers.push(once)
        return once
    }
    const own = (what: string, name: string) => {
        if (!name.startsWith(`${id}.`)) throw new Error(`${what} "${name}" must start with "${id}."`)
    }
    // A loaded extension's fence widgets and Journal Panels mount like its Views: in a shadow root
    // holding its stylesheets, unless it mounts in the page (ADR 0121, amended 2026-10-10).
    const fenceIsolation =
        entry.source === 'loaded' && manifest.isolation !== 'page' ? { styles: (manifest.styles ?? []).map((path) => `${entry.base}${path.replace(/^\.\//, '')}`) } : null
    /** The extension's own icon by its registered name, or the Client's icon of that name. */
    const icon = (name: string | undefined) => (name !== undefined && ownIcons.has(name) ? `${id}.${name}` : name)

    // The (kind, id) pairs this extension added, so `unregister` can tell its own from others'.
    // Neither a kind nor an id may contain `:` (contribution-registry.ts), so it separates them.
    const added = new Set<string>()
    const contributions: ExtensionContributions = {
        register(kind, contributionId, value) {
            if (disposed) return noop
            const undo = graph.contributions.register(kind, contributionId, value)
            const pair = `${kind}:${contributionId}`
            added.add(pair)
            return keep(() => {
                added.delete(pair)
                undo()
            })
        },
        unregister(kind, contributionId) {
            // Only the extension's own: one it never added stays where it is.
            const pair = `${kind}:${contributionId}`
            if (!added.delete(pair)) return
            graph.contributions.unregister(kind, contributionId)
        },
        get: (kind, contributionId) => graph.contributions.get(kind, contributionId),
        has: (kind, contributionId) => graph.contributions.has(kind, contributionId),
        list: (kind) => graph.contributions.list(kind),
    }

    const life: ContextLifecycle = { keep, disposed: () => disposed }

    /**
     * Hear when one of the extension's own settings changes, and not another's: what its fences'
     * quotes answer may follow them, so a kept quote is asked for again (ADR 0146).
     */
    const settingsPrefix = extensionSettingKey(id, '')
    const settingsNow = () => JSON.stringify(client.settings.keys(settingsPrefix).map((key) => [key, client.settings.get(key)]))
    const ownSettingsChanged = (listener: () => void): (() => void) => {
        if (disposed) return noop
        let last = settingsNow()
        return keep(
            client.settings.subscribe(() => {
                const now = settingsNow()
                if (now === last) return
                last = now
                listener()
            }),
        )
    }

    const context: ExtensionContext = {
        extensionId: id,
        graphId: graph.graphId,
        clientVersion: client.clientVersion,
        dev: client.dev,
        views: {
            register(kind, view) {
                if (!declaredKinds.has(kind)) throw new Error(`View kind "${kind}" is not declared in the manifest.`)
                return disposed ? noop : keep(supplyView(kind, view))
            },
        },
        commands: {
            register(commandId, handler) {
                own('Command', commandId)
                return disposed ? noop : keep(graph.commands.register(commandId, handler))
            },
            execute: (commandId, arg) => graph.commands.execute(commandId, arg),
            has: (commandId) => graph.commands.has(commandId),
        },
        contextMenu: {
            register(item: ContextMenuItem) {
                own('Context Menu row', item.id)
                if (disposed) return noop
                const row = { ...item, icon: icon(item.icon) } as unknown as ClientContextMenuItem
                return keep(registerContextMenuItem(graph.contributions, row))
            },
        },
        commandMenu: {
            register(item: CommandMenuItem) {
                own('Command Menu row', item.id)
                if (disposed) return noop
                const row = { ...item, icon: icon(item.icon) } as ClientCommandMenuItem
                return keep(registerCommandMenuItem(graph.contributions, row))
            },
        },
        commandBar: {
            register(button: CommandBarButton) {
                own('Command Bar button', button.id)
                if (disposed) return noop
                // Pinned, in the group at the bar's right end; otherwise after every editing button.
                return keep(
                    registerCommandBarItem(graph.contributions, {
                        id: button.id,
                        icon: icon(button.icon) ?? 'default',
                        label: button.title,
                        command: button.command,
                        args: button.args,
                        align: button.pinned ? 'end' : 'start',
                        order: EXTENSION_COMMAND_BAR_ORDER,
                    }),
                )
            },
        },
        graphSidebar: {
            register(button: GraphSidebarButton) {
                own('Graph Sidebar button', button.id)
                if (disposed) return noop
                return keep(registerGraphSidebarButton(graph.contributions, { ...button, icon: icon(button.icon) }))
            },
        },
        journalPanels: {
            register(panel) {
                own('Journal Panel', panel.id)
                if (disposed) return noop
                return keep(
                    registerJournalPanel(graph.contributions, {
                        id: panel.id,
                        extensionName: manifest.displayName,
                        isolation: fenceIsolation,
                        mount: (element, props) => panel.mount(element, props),
                    }),
                )
            },
        },
        keybindings: {
            register: (binding) => (disposed ? noop : keep(graph.keybindings.add(binding))),
        },
        contributions,
        events: {
            on<K extends ExtensionEventName>(name: K, listener: (payload: ExtensionEventPayloads[K]) => void) {
                if (!EXTENSION_EVENTS.includes(name)) throw new Error(`Extensions cannot listen to "${name}".`)
                if (disposed) return noop
                return keep(graph.events.on(name as EventName, listener as never))
            },
        },
        index: {
            allConcepts: () => graph.index.allConcepts(),
            linkGraph: () => graph.index.linkGraph(),
            onUpdated: (listener) => (disposed ? noop : keep(graph.index.onUpdated(listener))),
        },
        documents: graph.documents,
        records: graph.records(id),
        assets: graph.assets,
        layout: {
            ...graph.layout,
            // A window the extension opened closes with its context, as its other registrations go.
            openWindow(options) {
                if (disposed) return { close: noop }
                const opened = graph.layout.openWindow(options)
                const undo = keep(() => opened.close())
                return {
                    close() {
                        undo()
                    },
                }
            },
        },
        concepts: graph.concepts,
        storage: {
            get<T>(key: string): T | undefined {
                try {
                    const raw = client.storage?.getItem(storageKey(id, key))
                    return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as T)
                } catch {
                    return undefined
                }
            },
            set(key, value) {
                try {
                    client.storage?.setItem(storageKey(id, key), JSON.stringify(value))
                } catch {
                    // A browser refusing storage keeps nothing, which the API allows.
                }
            },
            remove(key) {
                try {
                    client.storage?.removeItem(storageKey(id, key))
                } catch {
                    // As above.
                }
            },
        },
        settings: extensionSettings(id, manifest, client, life),
        personStorage: extensionPersonStorage(id, client, life),
        auth: {
            redirectUri: client.signIn.redirectUri,
            authorize(url, options) {
                if (disposed) return Promise.reject(new Error(`${manifest.displayName} was stopped.`))
                return client.signIn.authorize(url, options)
            },
        },
        theme: { isDark: () => client.isDark() },
        // The Client's trusted markup is the API's `IconMarkup`: both are opaque, so it reaches the
        // extension's `{@html}` still trusted and is not sanitized a second time.
        icons: { svg: (name, options) => client.iconSvg(icon(name) ?? name, options) as unknown as IconMarkup },
        notify: (text) => graph.notify(text),
        editor: {
            registerFence(info, widget, options = {}) {
                // The extension's id, an ordinary fence, or a name under it, an Extension Fence
                // (ADR 0138): never another extension's word, and never one of the Client's own.
                const dot = info.indexOf('.')
                const owned = dot === -1 ? info === id : info.slice(0, dot) === id && FENCE_NAME.test(info.slice(dot + 1))
                if (!owned) throw new Error(`A fence's info word must be "${id}" or "${id}.<name>", not "${info}".`)
                if (disposed) return noop
                const fence = toInteractiveFence(manifest.displayName, widget, options, fenceIsolation, ownSettingsChanged)
                return keep(graph.contributions.register(INTERACTIVE_FENCE_KIND, info, fence))
            },
            insertBlock: (text, options) => (disposed ? false : graph.editor.insertBlock(text, options)),
            openPanel(options) {
                if (disposed) return null
                const panel = graph.editor.openPanel(options)
                // A panel the extension opened closes with its context.
                if (panel) keep(() => panel.close())
                return panel
            },
        },
        // The dialog names the extension, so a person knows who is asking.
        dialogs: { prompt: (options) => client.dialogs.prompt(options, manifest.displayName) },
        embeds: {
            frameHosts: PLAYER_FRAME_HOSTS,
            frame: (options) => buildFrame(options),
        },
    }

    return {
        context: entry.source === 'loaded' && entry.installed ? stableOnly(context) : context,
        dispose() {
            if (disposed) return
            disposed = true
            for (const undo of disposers.reverse()) {
                try {
                    undo()
                } catch (error) {
                    console.error(`[extensions] ${id}: taking back a registration failed`, error)
                }
            }
            disposers.length = 0
        },
    }
}

/** A Proposed member, for an extension that may not use it: any call throws, saying why. */
function refuse(member: string): () => never {
    return () => {
        throw new Error(`context.${member} is in the Proposed part of the Extension API, which only the extensions that come with EtherPK may use.`)
    }
}

/**
 * The context an extension from the Extension Directory gets: the Stable part of `context`, with
 * every Proposed member refusing. The Proposed part may change in any release, and `contributions`
 * reaches the Client's own registries, where an extension could take any kind's entries, another
 * extension's fence word among them. The reviewer checks a listed release uses only the Stable part,
 * and this keeps it to that. The plain values (`extensionId`, `graphId`, `clientVersion`, `dev`)
 * stay readable, since reading one reaches nothing.
 */
function stableOnly(context: ExtensionContext): ExtensionContext {
    const { layout, commands, editor } = context
    return {
        ...context,
        commands: { register: (commandId, handler) => commands.register(commandId, handler), execute: refuse('commands.execute'), has: refuse('commands.has') },
        layout: {
            isDesktop: () => layout.isDesktop(),
            openView: (view, options) => layout.openView(view, options),
            openDocument: (concept, options) => layout.openDocument(concept, options),
            activeDocument: refuse('layout.activeDocument'),
            reveal: refuse('layout.reveal'),
            openWindow: refuse('layout.openWindow'),
        },
        editor: {
            registerFence: (info, widget, options) => editor.registerFence(info, widget, options),
            insertBlock: (text, options) => editor.insertBlock(text, options),
            openPanel: refuse('editor.openPanel'),
        },
        documents: {
            list: refuse('documents.list'),
            read: refuse('documents.read'),
            links: refuse('documents.links'),
            search: refuse('documents.search'),
            backlinks: refuse('documents.backlinks'),
            formatGuide: refuse('documents.formatGuide'),
            tasks: refuse('documents.tasks'),
        },
        records: { get: refuse('records.get'), set: refuse('records.set'), remove: refuse('records.remove'), keys: refuse('records.keys') },
        assets: { prepareImage: refuse('assets.prepareImage'), saveImage: refuse('assets.saveImage') },
        contributions: {
            register: refuse('contributions.register'),
            unregister: refuse('contributions.unregister'),
            get: refuse('contributions.get'),
            has: refuse('contributions.has'),
            list: refuse('contributions.list'),
        },
        contextMenu: { register: refuse('contextMenu.register') },
        commandBar: { register: refuse('commandBar.register') },
        keybindings: { register: refuse('keybindings.register') },
        index: { allConcepts: refuse('index.allConcepts'), linkGraph: refuse('index.linkGraph'), onUpdated: refuse('index.onUpdated') },
        concepts: { canonicalName: refuse('concepts.canonicalName'), key: refuse('concepts.key') },
        icons: { svg: refuse('icons.svg') },
    }
}

/** An extension's Command Bar buttons sort after the Client's own (the last, zoom in, is 110). */
const EXTENSION_COMMAND_BAR_ORDER = 1000

/** Where an extension's stored value lives: `etherpk-<id>:<key>`, the form older keys take. */
export function storageKey(extensionId: string, key: string): string {
    return `etherpk-${extensionId}:${key}`
}
