/**
 * What the workspace reports to usage statistics (ADR 0187): the graph that opened, the Views
 * opened, and the Commands run. Only constants from code go into an event: a Command id, a View
 * kind, a file type from a fixed list, and buckets. Never a View's target (a page or file name)
 * or a Command's argument.
 *
 * An extension's Command ids and View kinds start with its id. The Built-in Extensions' are
 * reported as they are; another extension's are reported as `command.extension` and
 * `view.extension`, since its ids are its author's to choose.
 */

import { DEMO_GRAPH_ID, isDemoGraph } from '#lib/demo/demo-graph.js'
import type { ViewRef } from '#lib/layout/view-ref.js'
import { assetExtension } from '#lib/surface/asset-viewer.js'
import { createCommandRegistry, type CommandRegistry } from '#lib/surface/command-registry.js'

import { assetType, openTimeBucket, pageCountBucket, type UsageEvent } from './usage-catalogue'

interface Recorder {
    record(event: UsageEvent): void
}

export interface WorkspaceUsage {
    /** The workspace's registry: each Command run through it is reported. */
    commands: CommandRegistry
    /** The same registry, as extensions are given it: it records which ids are an extension's. */
    extensionCommands: CommandRegistry
    /** A View was opened or brought forward through the Layout controller. */
    viewOpened(view: ViewRef): void
    /** The graph finished opening. */
    graphOpened(graph: { graphId: string; synced: boolean; folder: boolean; pages: number; openMs: number }): void
}

export function createWorkspaceUsage(statistics: Recorder, bundledExtensions: ReadonlySet<string>): WorkspaceUsage {
    const fromExtensions = new Set<string>()
    /** A name an extension chose, as it may be sent: its own for a Built-in Extension. */
    const extensionName = (name: string) => (bundledExtensions.has(name.split('.')[0]) ? name : 'extension')

    const commands = createCommandRegistry({
        onExecute: (id) => statistics.record({ name: `command.${fromExtensions.has(id) ? extensionName(id) : id}` }),
    })

    return {
        commands,
        extensionCommands: {
            ...commands,
            register: (id, handler) => {
                fromExtensions.add(id)
                return commands.register(id, handler)
            },
        },
        viewOpened(view) {
            // A namespaced kind (`kanban.board`) is an extension's; the Client's own have no dot.
            if (view.kind.includes('.')) return statistics.record({ name: `view.${extensionName(view.kind)}` })
            const data = view.kind === 'asset' ? { type: assetType(assetExtension(view.target)) } : undefined
            statistics.record({ name: `view.${view.kind}`, ...(data ? { data } : {}) })
        },
        graphOpened({ graphId, synced, folder, pages, openMs }) {
            // The demo is not a graph of the person's.
            if (isDemoGraph(graphId)) return
            const kind = synced ? 'synced' : folder ? 'folder' : 'browser'
            statistics.record({ name: 'graph_opened', data: { kind, pages: pageCountBucket(pages), openTime: openTimeBucket(openMs) } })
        },
    }
}

/** Whether a page of the app is the demo, where nothing is counted. */
export function isDemoPath(pathname: string): boolean {
    return pathname === '/demo' || pathname === `/g/${DEMO_GRAPH_ID}` || pathname.startsWith(`/g/${DEMO_GRAPH_ID}/`)
}
