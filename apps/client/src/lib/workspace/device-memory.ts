/**
 * Small per-device, per-graph conveniences the workspace remembers between visits, in
 * localStorage beside [[Recents]] and the folder path (ADR 0013): never synced, never in an
 * Export, and nothing breaks when the store is blocked or empty.
 *
 * - The Settings modal's last tab, so someone working on a publication is not sent back to
 *   General for every edit (2026-09-19).
 * - The publication last published from this device, so the Publish command can run it again
 *   without asking which.
 */

export const SETTINGS_TAB_KEY_PREFIX = 'etherpk-settings-tab:'
export const LAST_PUBLICATION_KEY_PREFIX = 'etherpk-last-publication:'

export const SETTINGS_TABS = ['general', 'spelling', 'protection', 'mirror', 'agents', 'publish', 'maintenance'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

function read(key: string, storage: Storage | undefined): string | null {
    try {
        const raw = storage?.getItem(key)?.trim()
        return raw ? raw : null
    } catch {
        return null
    }
}

function write(key: string, value: string, storage: Storage | undefined): void {
    // Best-effort: a blocked or full store must not break the action that remembered the value.
    try {
        if (value.trim() === '') storage?.removeItem(key)
        else storage?.setItem(key, value.trim())
    } catch {
        /* storage blocked */
    }
}

/** The tab the Settings modal was last on for this graph, or null when unknown or not a tab. */
export function readSettingsTab(graphId: string, storage: Storage | undefined = globalThis.localStorage): SettingsTab | null {
    const raw = read(`${SETTINGS_TAB_KEY_PREFIX}${graphId}`, storage)
    return raw && (SETTINGS_TABS as readonly string[]).includes(raw) ? (raw as SettingsTab) : null
}

export function writeSettingsTab(graphId: string, tab: SettingsTab, storage: Storage | undefined = globalThis.localStorage): void {
    write(`${SETTINGS_TAB_KEY_PREFIX}${graphId}`, tab, storage)
}

/** The id of the publication last published from this device for the graph, or null. */
export function readLastPublication(graphId: string, storage: Storage | undefined = globalThis.localStorage): string | null {
    return read(`${LAST_PUBLICATION_KEY_PREFIX}${graphId}`, storage)
}

/** Remember the publication just published; blank forgets it. */
export function writeLastPublication(graphId: string, publicationId: string, storage: Storage | undefined = globalThis.localStorage): void {
    write(`${LAST_PUBLICATION_KEY_PREFIX}${graphId}`, publicationId, storage)
}
