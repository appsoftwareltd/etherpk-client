import { describe, expect, it, vi } from 'vitest'

import { admitInstalled, buildCatalogue, type InstalledPackage, withInstalled } from './catalogue'
import { createInstalledExtensions, INSTALLED_EXTENSIONS_KEY } from './installed'

/** A Storage over a plain map, as localStorage behaves. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
    const values = new Map(Object.entries(initial))
    return {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    }
}

const INTEGRITY = `sha512-${'A'.repeat(86)}==`

function orchard(etherpk: Record<string, unknown> = {}, version = '1.0.0') {
    return {
        name: '@example/etherpk-extension-orchard',
        version,
        etherpk: { id: 'orchard', displayName: 'Orchard', publisher: 'example', minClientVersion: '0.9.0', main: './dist/main.js', ...etherpk },
    }
}

function installed(packageJson: unknown = orchard(), overrides: Partial<InstalledPackage> = {}): InstalledPackage {
    return { id: 'orchard', version: '1.0.0', integrity: INTEGRITY, packageJson, base: '/extensions/orchard/00112233445566778899aabbccddeeff/', ...overrides }
}

const builtIns = buildCatalogue({ clientVersion: '0.9.6', compiledIn: [{ folder: 'kanban', packageJson: { name: 'kanban', version: '0.9.6', etherpk: { id: 'kanban', displayName: 'Kanban', publisher: 'App Software', main: './src/extension.ts' } }, module: { activate: () => {} } }], loaded: [] })

describe('the releases installed on this device', () => {
    it('keeps each release with its package.json, one per extension, across a reload', () => {
        const storage = memoryStorage()
        const list = createInstalledExtensions(storage)
        list.put({ id: 'orchard', version: '1.0.0', integrity: INTEGRITY, packageJson: orchard() })
        list.put({ id: 'orchard', version: '1.1.0', integrity: INTEGRITY, packageJson: orchard({}, '1.1.0') })
        expect(createInstalledExtensions(storage).list().map((release) => release.version)).toEqual(['1.1.0'])
        list.remove('orchard')
        expect(createInstalledExtensions(storage).list()).toEqual([])
    })

    it('keeps a newer release beside the running one, and puts it in place as the Client next starts', () => {
        const storage = memoryStorage()
        const list = createInstalledExtensions(storage)
        list.put({ id: 'orchard', version: '1.0.0', integrity: INTEGRITY, packageJson: orchard() })
        list.stage('orchard', { version: '1.1.0', integrity: INTEGRITY, packageJson: orchard({}, '1.1.0') })
        list.stage('pear', { version: '2.0.0', integrity: INTEGRITY, packageJson: {} })
        expect(list.list()).toMatchObject([{ version: '1.0.0', next: { version: '1.1.0' } }])

        const started = createInstalledExtensions(storage)
        expect(started.promoteStaged(1_000)).toEqual(['orchard'])
        expect(started.list()).toEqual([{ id: 'orchard', version: '1.1.0', integrity: INTEGRITY, packageJson: orchard({}, '1.1.0'), updatedAt: 1_000 }])
        expect(started.promoteStaged(2_000)).toEqual([])
    })

    it('tells its listeners about each change, and reads a damaged list as empty', () => {
        const list = createInstalledExtensions(memoryStorage({ [INSTALLED_EXTENSIONS_KEY]: '{not json' }))
        expect(list.list()).toEqual([])
        const listener = vi.fn()
        list.subscribe(listener)
        list.put({ id: 'orchard', version: '1.0.0', integrity: INTEGRITY, packageJson: orchard() })
        list.remove('nothing')
        expect(listener).toHaveBeenCalledTimes(1)
    })
})

describe('an installed release in the catalogue', () => {
    it('is a loaded extension served from its release address, after the built-ins', () => {
        const catalogue = withInstalled(builtIns, [installed()], '0.9.6')
        expect(catalogue.extensions.map((entry) => entry.id)).toEqual(['kanban', 'orchard'])
        expect(catalogue.extensions[1]).toMatchObject({ source: 'loaded', base: '/extensions/orchard/00112233445566778899aabbccddeeff/', installed: { version: '1.0.0', integrity: INTEGRITY } })
        // The built-in catalogue itself is untouched: each host gets its own copy.
        expect(builtIns.extensions.map((entry) => entry.id)).toEqual(['kanban'])
    })

    it.each([
        ['a package for another extension', installed(orchard({ id: 'garden' })), /"garden", not "orchard"/],
        ['another version than the one installed', installed(orchard({}, '2.0.0')), /version 2.0.0, not the 1.0.0/],
        ['no minClientVersion', installed(orchard({ minClientVersion: undefined })), /must name its minClientVersion/],
        ['a newer Client than this one', installed(orchard({ minClientVersion: '1.0.0' })), /needs Client 1.0.0 or later/],
        ['the id of a built-in', installed(orchard({ id: 'kanban' }), { id: 'kanban' }), /taken by another extension/],
        ['a fence word the Client draws itself', installed(orchard({ id: 'mermaid' }), { id: 'mermaid' }), /"mermaid" names a block the Client draws itself/],
        ["the Maps extension's fence word", installed(orchard({ id: 'map' }), { id: 'map' }), /"map" names a block the Client draws itself/],
    ])('is refused for %s, and listed as broken with why', (_case, release, reason) => {
        expect(admitInstalled(builtIns, release, '0.9.6')).toMatchObject({ ok: false, errors: [expect.stringMatching(reason)] })
        const catalogue = withInstalled(builtIns, [release], '0.9.6')
        expect(catalogue.broken).toEqual([{ where: expect.stringMatching(/from the Extension Directory$/), errors: [expect.stringMatching(reason)] }])
    })

    it('may declare View addresses, under its own id, whatever segments the built-ins or the Client use', () => {
        const views = [
            { kind: 'orchard.trees', title: 'Trees', region: 'main', address: { segment: 'trees', target: 'concept' } },
            { kind: 'orchard.board', title: 'Board', region: 'main', address: { segment: 'k', target: 'concept' } },
            { kind: 'orchard.docs', title: 'Docs', region: 'main', address: { segment: 'd', target: 'concept' } },
        ]
        const kanbanWithAddress = buildCatalogue({
            clientVersion: '0.9.6',
            compiledIn: [{ folder: 'kanban', packageJson: { name: 'kanban', version: '0.9.6', etherpk: { id: 'kanban', displayName: 'Kanban', publisher: 'App Software', main: './src/extension.ts', views: [{ kind: 'kanban.board', title: 'Kanban', region: 'main', address: { segment: 'k', target: 'concept' } }] } }, module: { activate: () => {} } }],
            loaded: [],
        })
        expect(admitInstalled(kanbanWithAddress, installed(orchard({ views })), '0.9.6')).toMatchObject({ ok: true })
    })
})
