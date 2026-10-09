/**
 * Test support: the Kanban Board's context as the Client builds it for a graph, over the Client's
 * real registries and bus, and checked against the real manifest. Imported by tests only.
 */
import type { ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { buildCatalogue } from '$lib/extensions/catalogue'
import { createScopedContext } from '$lib/extensions/scoped-context'
import { fakeClientServices, fakeGraphServices } from '$lib/extensions/testing'

import packageJson from '../package.json'

export function kanbanContext(options: { desktop?: boolean } = {}) {
    const { services } = fakeGraphServices()
    services.layout.isDesktop = () => options.desktop ?? true
    const catalogue = buildCatalogue({ clientVersion: '0.8.54', compiledIn: [{ folder: 'kanban', packageJson, module: { activate: () => {} } }], loaded: [] })
    const [entry] = catalogue.extensions
    if (!entry) throw new Error(`The manifest was refused: ${JSON.stringify(catalogue.broken)}`)
    const views = new Map<string, ViewContribution>()
    const scoped = createScopedContext(entry, services, fakeClientServices(), (kind, view) => {
        views.set(kind, view)
        return () => views.delete(kind)
    })
    return { context: scoped.context, services, views, dispose: scoped.dispose }
}
