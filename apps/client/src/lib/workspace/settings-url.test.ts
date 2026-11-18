import { describe, expect, it } from 'vitest'

import { agentsSettingsUrl, SETTINGS_PARAM, settingsTabFromUrl, withSettingsTab, withoutSettingsTab } from './settings-url'

// Settings rides the query string of whatever address is beneath it (ADR 0023, 2026-09-20):
// `?settings=<tab>` is the modal open on that tab, and its absence is the modal closed. The
// fragment stays reserved for in-document anchors.

describe('agentsSettingsUrl', () => {
    it("is a graph's Agents tab, which an address reads back as that tab", () => {
        const url = agentsSettingsUrl('https://app.test', { where: 'sync', name: 'g-1' })
        expect(url).toBe('https://app.test/graph/sync/g-1?settings=agents')
        expect(settingsTabFromUrl(new URL(url))).toBe('agents')
    })

    it('encodes the graph id', () => {
        expect(agentsSettingsUrl('https://app.test', { where: 'sync', name: 'a b' })).toBe('https://app.test/graph/sync/a%20b?settings=agents')
    })
})

describe('settingsTabFromUrl', () => {
    it('reads the tab an address names', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1/d/Physics?settings=publish'))).toBe('publish')
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1?backend=server&settings=general'))).toBe('general')
    })

    it('is null for an address that names no tab', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1/d/Physics'))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1/d/Physics?backend=server'))).toBeNull()
    })

    it('is null for a value that is not a tab, so a hand-edited address cannot open an empty panel', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1?settings=bogus'))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1?settings='))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/graph/sync/g1?settings'))).toBeNull()
    })
})

describe('withSettingsTab', () => {
    it('adds the tab to an empty query string', () => {
        expect(withSettingsTab('', 'publish')).toBe(`?${SETTINGS_PARAM}=publish`)
    })

    it('keeps every other param - the dev and e2e flags ride the same query string', () => {
        expect(withSettingsTab('?backend=server&autosaveMs=150', 'mirror')).toBe('?backend=server&autosaveMs=150&settings=mirror')
    })

    it('replaces a tab already named rather than adding a second', () => {
        expect(withSettingsTab('?settings=general&backend=server', 'publish')).toBe('?backend=server&settings=publish')
    })
})

describe('withoutSettingsTab', () => {
    it('drops the param and keeps the rest', () => {
        expect(withoutSettingsTab('?backend=server&settings=publish')).toBe('?backend=server')
        expect(withoutSettingsTab('?settings=publish&backend=server')).toBe('?backend=server')
    })

    it('leaves an address with no tab alone, and yields an empty string rather than a bare "?"', () => {
        expect(withoutSettingsTab('?backend=server')).toBe('?backend=server')
        expect(withoutSettingsTab('?settings=publish')).toBe('')
        expect(withoutSettingsTab('')).toBe('')
    })
})
