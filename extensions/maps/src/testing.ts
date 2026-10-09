/**
 * Test support: maps' catalogue entry, read from the real manifest, and the context the Client
 * builds for it in a graph, over the Client's real registries and bus. Imported by tests only.
 */
import type { ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { buildCatalogue, type Catalogue } from '$lib/extensions/catalogue'
import { createScopedContext } from '$lib/extensions/scoped-context'
import { fakeClientServices, fakeGraphServices } from '$lib/extensions/testing'

import packageJson from '../package.json'

/** The catalogue a Client holding only maps would build. */
export function mapsCatalogue(): Catalogue {
    const catalogue = buildCatalogue({ clientVersion: '0.8.54', compiledIn: [{ folder: 'maps', packageJson, module: { activate: () => {} } }], loaded: [] })
    if (catalogue.extensions.length !== 1) throw new Error(`The manifest was refused: ${JSON.stringify(catalogue.broken)}`)
    return catalogue
}

export function mapsContext(options: { desktop?: boolean } = {}) {
    const { services } = fakeGraphServices()
    services.layout.isDesktop = () => options.desktop ?? true
    const views = new Map<string, ViewContribution>()
    const scoped = createScopedContext(mapsCatalogue().extensions[0], services, fakeClientServices(), (kind, view) => {
        views.set(kind, view)
        return () => views.delete(kind)
    })
    return { context: scoped.context, services, views, dispose: scoped.dispose }
}
