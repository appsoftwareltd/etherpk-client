import { describe, expect, it } from 'vitest'

import { SETTINGS_PARAM, settingsTabFromUrl, withSettingsTab, withoutSettingsTab } from './settings-url'

// Settings rides the query string of whatever address is beneath it (ADR 0023, 2026-09-20):
// `?settings=<tab>` is the modal open on that tab, and its absence is the modal closed. The
// fragment stays reserved for in-document anchors.

describe('settingsTabFromUrl', () => {
    it('reads the tab an address names', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1/d/Physics?settings=publish'))).toBe('publish')
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1?fs=opfs&settings=general'))).toBe('general')
    })

    it('is null for an address that names no tab', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1/d/Physics'))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1/d/Physics?fs=opfs'))).toBeNull()
    })

    it('is null for a value that is not a tab, so a hand-edited address cannot open an empty panel', () => {
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1?settings=bogus'))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1?settings='))).toBeNull()
        expect(settingsTabFromUrl(new URL('https://app.test/g/g1?settings'))).toBeNull()
    })
})

describe('withSettingsTab', () => {
    it('adds the tab to an empty query string', () => {
        expect(withSettingsTab('', 'publish')).toBe(`?${SETTINGS_PARAM}=publish`)
    })

    it('keeps every other param - the dev and e2e flags ride the same query string', () => {
        expect(withSettingsTab('?fs=opfs&autosaveMs=150', 'mirror')).toBe('?fs=opfs&autosaveMs=150&settings=mirror')
    })

    it('replaces a tab already named rather than adding a second', () => {
        expect(withSettingsTab('?settings=general&fs=opfs', 'publish')).toBe('?fs=opfs&settings=publish')
    })
})

describe('withoutSettingsTab', () => {
    it('drops the param and keeps the rest', () => {
        expect(withoutSettingsTab('?fs=opfs&settings=publish')).toBe('?fs=opfs')
        expect(withoutSettingsTab('?settings=publish&fs=opfs')).toBe('?fs=opfs')
    })

    it('leaves an address with no tab alone, and yields an empty string rather than a bare "?"', () => {
        expect(withoutSettingsTab('?fs=opfs')).toBe('?fs=opfs')
        expect(withoutSettingsTab('?settings=publish')).toBe('')
        expect(withoutSettingsTab('')).toBe('')
    })
})
