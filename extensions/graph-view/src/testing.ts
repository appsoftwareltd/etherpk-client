/**
 * Test support: an extension context over plain maps, recording what the Graph View adds, as the
 * Client would hold it. Only the Extension API's types are used, as an extension built outside
 * the Client can only use them. Imported by tests only.
 */
import type { ContextMenuItem, ExtensionContext, IconMarkup, Keybinding, MenuTarget, ViewContribution, ViewRef } from '@appsoftwareltd/etherpk-extension-api'
import { vi } from 'vitest'

export function fakeContext(options: { desktop?: boolean } = {}) {
    const views = new Map<string, ViewContribution>()
    const commands = new Map<string, (arg?: unknown) => unknown>()
    const rows: ContextMenuItem[] = []
    const keybindings: Keybinding[] = []
    const layout = {
        openView: vi.fn<(view: ViewRef, options?: { inPaneOf?: string; beside?: string }) => void>(),
        reveal: vi.fn<(kind: string) => void>(),
        openDocument: vi.fn<(concept: string, options?: { line?: number; inPaneOf?: string; beside?: string }) => void>(),
        activeDocument: () => null,
        isDesktop: () => options.desktop ?? true,
    }
    const context: ExtensionContext = {
        extensionId: 'graph-view',
        graphId: 'g1',
        clientVersion: '0.8.54',
        dev: false,
        views: {
            register(kind, view) {
                views.set(kind, view)
                return () => views.delete(kind)
            },
        },
        commands: {
            register(id, handler) {
                commands.set(id, handler)
                return () => commands.delete(id)
            },
            execute: async (id, arg) => commands.get(id)?.(arg),
            has: (id) => commands.has(id),
        },
        contextMenu: {
            register(item) {
                rows.push(item)
                return () => rows.splice(rows.indexOf(item), 1)
            },
        },
        commandMenu: { register: () => () => {} },
        graphSidebar: { register: () => () => {} },
        keybindings: {
            register(binding) {
                keybindings.push(binding)
                return () => keybindings.splice(keybindings.indexOf(binding), 1)
            },
        },
        contributions: { register: () => () => {}, unregister: () => {}, get: () => undefined, has: () => false, list: () => [] },
        events: { on: () => () => {} },
        index: { allConcepts: () => [], linkGraph: async () => ({ concepts: [], links: [] }), onUpdated: () => () => {} },
        layout,
        concepts: { key: (name) => name.toLowerCase(), canonicalName: (name) => name },
        storage: { get: () => undefined, set: () => {}, remove: () => {} },
        settings: { get: () => undefined, subscribe: () => () => {} },
        theme: { isDark: () => false },
        // A stand-in for the Client's markup: tests read it as the string it is underneath.
        icons: { svg: (name) => `<svg data-icon="${name}"/>` as unknown as IconMarkup },
        notify: vi.fn(),
    }
    /** The rows a Context Menu raised on `target` would list. */
    const rowsFor = (target: MenuTarget) => rows.filter((row) => !row.when || row.when(target))
    return { context, views, commands, rows, rowsFor, keybindings, layout }
}
