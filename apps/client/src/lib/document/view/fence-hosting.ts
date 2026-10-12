/**
 * Where an interactive fence's widget can be drawn outside the document it sits in: a tab of its own
 * and a layer over the whole window. The widget asks through its context (`openInTab`,
 * `openWindow`), and the open workspace answers, since only it holds the Layout and the document
 * store. The editor knows nothing of either.
 *
 * A fence is named by its document, its info word and the id its registration reads from its body
 * (`identify`), which survives every edit to the document, where a fence's position does not.
 */

/** One fence, by its document, its info word and its own id. */
export interface FenceRef {
    document: string
    info: string
    id: string
}

/** What the open workspace offers: opening a fence in a tab, or over the window. */
export interface FenceHosting {
    openTab(fence: FenceRef): void
    openWindow(fence: FenceRef): void
}

let current: FenceHosting | null = null

/** Set by the workspace as a graph opens, and cleared (null) as it closes. */
export function setFenceHosting(hosting: FenceHosting | null): void {
    current = hosting
}

/** The open workspace's fence hosting, or null outside a workspace (the dev editor, tests). */
export function fenceHosting(): FenceHosting | null {
    return current
}

/** A fence tab's View target: the fence's ref as JSON, which round-trips through a saved Layout. */
export function fenceViewTarget(fence: FenceRef): string {
    return JSON.stringify([fence.document, fence.info, fence.id])
}

/** The fence a fence tab's target names, or null for a target that is not one. */
export function parseFenceViewTarget(target: string): FenceRef | null {
    try {
        const value: unknown = JSON.parse(target)
        if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === 'string' && part !== '')) return null
        const [document, info, id] = value as string[]
        return { document, info, id }
    } catch {
        return null
    }
}
