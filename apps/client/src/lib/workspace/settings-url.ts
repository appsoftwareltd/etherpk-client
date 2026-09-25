/**
 * Where [[Settings]] lives in the address (ADR 0023, 2026-09-20).
 *
 * Settings is the one dialog that is a place in the Navigation History rather than a prompt,
 * so the address says when it is open and on which tab: `?settings=<tab>` on top of whatever
 * Document URL (or Asset or Theme URL) is beneath it. The fragment is not used - ADR 0023
 * reserves it for in-document anchors - and every other param rides along untouched, because
 * the dev and e2e flags (`?fs=opfs`, `?autosaveMs=`) share the same query string.
 *
 * Pure string helpers over a query string, so the workspace's history writes and its tests
 * agree on the spelling without a browser.
 */

import { SETTINGS_TABS, type SettingsTab } from './device-memory'

export const SETTINGS_PARAM = 'settings'

/** The tab an address names, or null when it names none - or names something that is not a tab. */
export function settingsTabFromUrl(url: URL): SettingsTab | null {
    const raw = url.searchParams.get(SETTINGS_PARAM)
    return raw && (SETTINGS_TABS as readonly string[]).includes(raw) ? (raw as SettingsTab) : null
}

/** `search` with the tab named - in place of any tab already named, never beside it. */
export function withSettingsTab(search: string, tab: SettingsTab): string {
    const params = new URLSearchParams(search)
    params.delete(SETTINGS_PARAM)
    params.set(SETTINGS_PARAM, tab)
    return `?${params}`
}

/** `search` with no tab named; an empty string rather than a bare `?` when nothing is left. */
export function withoutSettingsTab(search: string): string {
    const params = new URLSearchParams(search)
    params.delete(SETTINGS_PARAM)
    const rest = params.toString()
    return rest ? `?${rest}` : ''
}
