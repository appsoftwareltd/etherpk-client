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
 *   store, a key or a sync engine.
 *
 * After `dispose` the context adds nothing: a callback that fires late does no harm.
 */
import type {
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

import { extensionSettingKey } from '$lib/person-settings/person-settings'
import { registerCommandMenuItem, type CommandMenuItem as ClientCommandMenuItem } from '$lib/surface/command-menu'
import { registerContextMenuItem, type ContextMenuItem as ClientContextMenuItem } from '$lib/surface/context-menu'
import { registerGraphSidebarButton } from '$lib/surface/graph-sidebar-buttons'
import type { EventName } from '$lib/surface'

import type { CatalogueEntry } from './catalogue'
import type { ClientServices, GraphServices } from './services'

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
        graphSidebar: {
            register(button: GraphSidebarButton) {
                own('Graph Sidebar button', button.id)
                if (disposed) return noop
                return keep(registerGraphSidebarButton(graph.contributions, { ...button, icon: icon(button.icon) }))
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
        layout: graph.layout,
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
        settings: {
            get: (setting) => client.settings.get(extensionSettingKey(id, setting)),
            subscribe: (listener) => (disposed ? noop : keep(client.settings.subscribe(listener))),
        },
        theme: { isDark: () => client.isDark() },
        // The Client's trusted markup is the API's `IconMarkup`: both are opaque, so it reaches the
        // extension's `{@html}` still trusted and is not sanitized a second time.
        icons: { svg: (name, options) => client.iconSvg(icon(name) ?? name, options) as unknown as IconMarkup },
        notify: (text) => graph.notify(text),
    }

    return {
        context,
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

/** Where an extension's stored value lives: `etherpk-<id>:<key>`, the form older keys take. */
export function storageKey(extensionId: string, key: string): string {
    return `etherpk-${extensionId}:${key}`
}
