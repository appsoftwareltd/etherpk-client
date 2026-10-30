/**
 * Which of the Sidebar's [[Bookmark]] groups this device keeps collapsed, per graph. A presentation
 * preference like [[Layout]]: per device, never synced and never in an Export. Storage can be
 * missing or refuse (a private window, cleared site data), so every read and write is guarded and
 * the Sidebar works without it.
 */

const KEY_PREFIX = 'etherpk-bookmark-groups:'

export function readCollapsedGroups(graphId: string | undefined): Set<string> {
    if (!graphId) return new Set()
    try {
        const raw = JSON.parse(localStorage.getItem(KEY_PREFIX + graphId) ?? '[]')
        return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
    } catch {
        return new Set()
    }
}

export function writeCollapsedGroups(graphId: string | undefined, collapsed: ReadonlySet<string>): void {
    if (!graphId) return
    try {
        localStorage.setItem(KEY_PREFIX + graphId, JSON.stringify([...collapsed]))
    } catch {
        // Not remembered on this device; the groups still collapse for this session.
    }
}
