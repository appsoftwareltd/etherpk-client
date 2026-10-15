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
