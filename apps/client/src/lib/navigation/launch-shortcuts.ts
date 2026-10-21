/**
 * The query parameters an [[Installed App]] launch carries, and the ones the root resolver hands
 * on to a workspace. Pure string helpers, shared by the root (`/`) resolver, the workspace and
 * their tests so they agree on the spelling without a browser.
 *
 * - `source=pwa` marks a launch from the installed app: the web manifest's `start_url` and every
 *   shortcut carry it, so the Client's request log can count installed launches. It names nothing
 *   about the person and is dropped before the address is shown.
 * - `shortcut=<name>` is an app icon shortcut from the manifest's `shortcuts` (and ChromeOS's
 *   `note_taking.new_note_url`). The root resolver turns it into a destination in the graph it
 *   would have opened anyway.
 * - `launch=<name>` asks the workspace to run one action once the graph is open, for a shortcut
 *   that is an action rather than a document. The workspace removes it from the address after.
 */

export const INSTALLED_LAUNCH_PARAM = 'source'
export const INSTALLED_LAUNCH_VALUE = 'pwa'
export const SHORTCUT_PARAM = 'shortcut'
export const WORKSPACE_LAUNCH_PARAM = 'launch'

/** The app icon shortcuts the manifest declares. */
export const LAUNCH_SHORTCUTS = ['today', 'search', 'quick-note'] as const
export type LaunchShortcut = (typeof LAUNCH_SHORTCUTS)[number]

/** The shortcuts that are an action in the workspace rather than a document to open. */
export const WORKSPACE_LAUNCHES = ['search', 'quick-note'] as const
export type WorkspaceLaunch = (typeof WORKSPACE_LAUNCHES)[number]

/** The shortcut a query string names, or null when it names none or one this build does not know. */
export function launchShortcutFrom(search: string): LaunchShortcut | null {
    const raw = new URLSearchParams(search).get(SHORTCUT_PARAM)
    return (LAUNCH_SHORTCUTS as readonly string[]).includes(raw ?? '') ? (raw as LaunchShortcut) : null
}

/** Whether a query string marks a launch from the installed app. */
export function isInstalledLaunch(search: string): boolean {
    return new URLSearchParams(search).get(INSTALLED_LAUNCH_PARAM) === INSTALLED_LAUNCH_VALUE
}

/** The workspace action a query string asks for, or null. */
export function workspaceLaunchFrom(search: string): WorkspaceLaunch | null {
    const raw = new URLSearchParams(search).get(WORKSPACE_LAUNCH_PARAM)
    return (WORKSPACE_LAUNCHES as readonly string[]).includes(raw ?? '') ? (raw as WorkspaceLaunch) : null
}

/**
 * `search` without the named parameters: an empty string rather than a bare `?` when nothing is
 * left. Every other parameter rides along untouched, because the dev and e2e flags (`?fs=opfs`)
 * share the query string.
 */
export function withoutParams(search: string, names: readonly string[]): string {
    const params = new URLSearchParams(search)
    for (const name of names) params.delete(name)
    const rest = params.toString()
    return rest ? `?${rest}` : ''
}
