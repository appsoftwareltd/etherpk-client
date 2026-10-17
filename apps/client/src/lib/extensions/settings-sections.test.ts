import type { ExtensionModule, ExtensionPackage, SettingsSection } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it, vi } from 'vitest'

import { createPersonSettings } from '$lib/person-settings/person-settings'

import type { Catalogue } from './catalogue'
import { settingsSectionsFor } from './settings-sections'
import { createExtensionSwitches } from './switches'
import { fakeClientServices, memoryStorage } from './testing'

function pkg(id: string): ExtensionPackage {
    return { name: `@example/${id}`, version: '0.12.0', manifest: { id, displayName: id === 'agent-chat' ? 'Agent Chat' : 'Kanban', publisher: 'App Software', main: './src/extension.ts' } }
}

function catalogue(sections: readonly SettingsSection[]): Catalogue {
    const module: ExtensionModule = { activate: () => {}, settingsSections: sections }
    return {
        extensions: [
            { id: 'agent-chat', package: pkg('agent-chat'), source: 'compiled-in', module },
            { id: 'kanban', package: pkg('kanban'), source: 'compiled-in', module: { activate: () => {} } },
        ],
        broken: [],
    }
}

const section = (id: string): SettingsSection => ({ id, tab: 'agents', mount: () => ({ destroy() {} }) })

describe('the settings sections extensions add to a tab, with no graph open (ADR 0134, amended 2026-10-15)', () => {
    it("lists the sections of the switched-on extensions for the tab, each named by its extension", () => {
        const found = settingsSectionsFor('agents', { catalogue: catalogue([section('models')]), switches: createExtensionSwitches(memoryStorage()), client: fakeClientServices(), notify: vi.fn() })
        expect(found.map((entry) => [entry.extensionId, entry.displayName, entry.section.id])).toEqual([['agent-chat', 'Agent Chat', 'models']])
    })

    it('lists nothing for an extension that is switched off', () => {
        const switches = createExtensionSwitches(memoryStorage())
        switches.set('agent-chat', false)
        expect(settingsSectionsFor('agents', { catalogue: catalogue([section('models')]), switches, client: fakeClientServices(), notify: vi.fn() })).toEqual([])
    })

    it("gives a section the extension's records kept with the person, and stops writing them once disposed", () => {
        const settings = createPersonSettings(() => memoryStorage())
        const [found] = settingsSectionsFor('agents', { catalogue: catalogue([section('models')]), switches: createExtensionSwitches(memoryStorage()), client: fakeClientServices(memoryStorage(), settings), notify: vi.fn() })
        found.context.personStorage.set('connections', [{ provider: 'anthropic' }])
        expect(found.context.personStorage.get('connections')).toEqual([{ provider: 'anthropic' }])
        expect(settings.get('extension-data.agent-chat.connections')).toBe('[{"provider":"anthropic"}]')
        found.dispose()
        found.context.personStorage.set('connections', [])
        expect(found.context.personStorage.get('connections')).toEqual([{ provider: 'anthropic' }])
    })
})

describe('the settings sections of an extension running in the open graph (ADR 0134, amended 2026-10-17)', () => {
    const garden: ExtensionPackage = { name: 'etherpk-extension-garden', version: '0.2.0', manifest: { id: 'garden', displayName: 'Garden', publisher: 'gbro3n', main: './dist/main.js', minClientVersion: '0.14.0' } }
    const loaded: Catalogue = { extensions: [{ id: 'garden', package: garden, source: 'loaded', base: '/extensions/garden/0.2.0/', installed: { version: '0.2.0', integrity: 'sha512-x' } }], broken: [] }
    const own: SettingsSection = { id: 'beds', tab: 'extension', mount: () => ({ destroy() {} }) }

    it("draws a loaded extension's sections while it runs in the graph, and not before", () => {
        const deps = { catalogue: loaded, switches: createExtensionSwitches(memoryStorage()), client: fakeClientServices(), notify: vi.fn() }
        expect(settingsSectionsFor('extension', deps)).toEqual([])
        const module: ExtensionModule = { activate: () => {}, settingsSections: [own] }
        const found = settingsSectionsFor('extension', { ...deps, loadedModule: (id) => (id === 'garden' ? module : null) })
        expect(found.map((entry) => [entry.extensionId, entry.section.id])).toEqual([['garden', 'beds']])
        expect(settingsSectionsFor('agents', { ...deps, loadedModule: () => module })).toEqual([])
    })

    it("draws only one extension's sections under its own entry", () => {
        const both: Catalogue = { extensions: [...loaded.extensions, { id: 'kanban', package: pkg('kanban'), source: 'compiled-in', module: { activate: () => {}, settingsSections: [{ ...own, id: 'lanes' }] } }], broken: [] }
        const deps = { catalogue: both, switches: createExtensionSwitches(memoryStorage()), client: fakeClientServices(), notify: vi.fn(), loadedModule: () => ({ activate: () => {}, settingsSections: [own] }) }
        expect(settingsSectionsFor('extension', { ...deps, extensionId: 'kanban' }).map((entry) => entry.section.id)).toEqual(['lanes'])
    })

    it('skips an export that is not a section the Client can draw, saying so', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const module = { activate: () => {}, settingsSections: [{ id: 'beds', tab: 'garden' }, own] } as unknown as ExtensionModule
        const found = settingsSectionsFor('extension', { catalogue: loaded, switches: createExtensionSwitches(memoryStorage()), client: fakeClientServices(), notify: vi.fn(), loadedModule: () => module })
        expect(found.map((entry) => entry.section.id)).toEqual(['beds'])
        expect(error).toHaveBeenCalledWith('[extensions] garden: one of its settingsSections is not a section the Client can draw', { id: 'beds', tab: 'garden' })
        error.mockRestore()
    })
})
