import { describe, expect, it } from 'vitest'

import { buildCatalogue, RESERVED_SEGMENTS } from './catalogue'

const activate = () => {}

function packageJson(id: string, etherpk: Record<string, unknown> = {}) {
    return {
        name: `@appsoftwareltd/etherpk-extension-${id}`,
        version: '0.8.54',
        etherpk: { id, displayName: id, publisher: 'App Software', main: './src/extension.ts', ...etherpk },
    }
}

describe('buildCatalogue', () => {
    it('reads a compiled-in extension with its module, and a loaded one with where it is served', () => {
        const catalogue = buildCatalogue({
            clientVersion: '0.8.54',
            compiledIn: [{ folder: 'kanban', packageJson: packageJson('kanban'), module: { activate } }],
            loaded: [{ packageJson: packageJson('graph-view', { main: './dist/main.js', minClientVersion: '0.8.54' }), base: '/extensions/graph-view/0.8.54/' }],
        })
        expect(catalogue.broken).toEqual([])
        expect(catalogue.extensions.map((entry) => [entry.id, entry.source])).toEqual([
            ['kanban', 'compiled-in'],
            ['graph-view', 'loaded'],
        ])
        const loaded = catalogue.extensions[1]
        expect(loaded.source === 'loaded' && loaded.base).toBe('/extensions/graph-view/0.8.54/')
    })

    it('lists a package whose manifest is wrong as broken, with every reason, and leaves it out', () => {
        const catalogue = buildCatalogue({
            clientVersion: '0.8.54',
            compiledIn: [{ folder: 'kanban', packageJson: packageJson('Kanban', { publisher: '' }), module: { activate } }],
            loaded: [],
        })
        expect(catalogue.extensions).toEqual([])
        expect(catalogue.broken).toEqual([
            {
                where: 'extensions/kanban',
                errors: ['"etherpk.id" must be lowercase letters, digits and hyphens, starting with a letter.', '"etherpk.publisher" must be a non-empty string.'],
            },
        ])
    })

    it('refuses a compiled-in module that does not export activate', () => {
        const catalogue = buildCatalogue({ clientVersion: '0.8.54', compiledIn: [{ folder: 'kanban', packageJson: packageJson('kanban'), module: {} }], loaded: [] })
        expect(catalogue.broken).toEqual([{ where: 'extensions/kanban', errors: ['src/extension.ts does not export an activate function.'] }])
    })

    it('refuses a loaded extension that names no minClientVersion, or a newer Client than this one', () => {
        const catalogue = buildCatalogue({
            clientVersion: '0.8.54',
            compiledIn: [],
            loaded: [
                { packageJson: packageJson('graph-view', { main: './dist/main.js' }), base: '/extensions/graph-view/1.0.0/' },
                { packageJson: packageJson('timeline', { main: './dist/main.js', minClientVersion: '0.10.0' }), base: '/extensions/timeline/1.0.0/' },
            ],
        })
        expect(catalogue.extensions).toEqual([])
        expect(catalogue.broken).toEqual([
            { where: '@appsoftwareltd/etherpk-extension-graph-view', errors: ['A loaded extension must name its minClientVersion.'] },
            { where: '@appsoftwareltd/etherpk-extension-timeline', errors: ['It needs Client 0.10.0 or later, and this Client is 0.8.54.'] },
        ])
    })

    it('compares versions by number, not as text', () => {
        const catalogue = buildCatalogue({
            clientVersion: '0.10.0',
            compiledIn: [],
            loaded: [{ packageJson: packageJson('graph-view', { main: './dist/main.js', minClientVersion: '0.9.12' }), base: '/x/' }],
        })
        expect(catalogue.broken).toEqual([])
    })

    it('refuses a second extension with an id already taken', () => {
        const catalogue = buildCatalogue({
            clientVersion: '0.8.54',
            compiledIn: [
                { folder: 'kanban', packageJson: packageJson('kanban'), module: { activate } },
                { folder: 'kanban-copy', packageJson: packageJson('kanban'), module: { activate } },
            ],
            loaded: [],
        })
        expect(catalogue.extensions.map((entry) => entry.id)).toEqual(['kanban'])
        expect(catalogue.broken).toEqual([{ where: 'extensions/kanban-copy', errors: ['The id "kanban" is taken by another extension.'] }])
    })

    it("refuses an address the Client keeps for itself or another extension declared first", () => {
        const view = (kind: string, segment: string) => ({ kind, title: 'T', region: 'main', address: { segment } })
        const catalogue = buildCatalogue({
            clientVersion: '0.8.54',
            compiledIn: [
                { folder: 'kanban', packageJson: packageJson('kanban', { views: [view('kanban.board', 'k')] }), module: { activate } },
                { folder: 'maps', packageJson: packageJson('maps', { views: [view('maps.map', 'k')] }), module: { activate } },
                { folder: 'docs', packageJson: packageJson('docs', { views: [view('docs.page', 'd')] }), module: { activate } },
            ],
            loaded: [],
        })
        expect(catalogue.extensions.map((entry) => entry.id)).toEqual(['kanban'])
        expect(catalogue.broken).toEqual([
            { where: 'extensions/maps', errors: ['The address "/k" is taken by kanban.'] },
            { where: 'extensions/docs', errors: ['The address "/d" is the Client\'s own.'] },
        ])
    })

    it('keeps the addresses of the Client\'s own routes', () => {
        expect(RESERVED_SEGMENTS).toEqual(expect.arrayContaining(['d', 'a', 't', 'x']))
    })
})
