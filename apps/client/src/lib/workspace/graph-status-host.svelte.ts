/**
 * The open graph's status, for the app's header.
 *
 * On a phone the workspace has no toolbar of its own, so its status dot sits in the app's header,
 * to the right of the logo. The header belongs to the route layout and the status to the workspace
 * beneath it, so the workspace publishes what the dot needs here and the layout draws it. Null on a
 * desktop (the workspace toolbar carries the dot there), and whenever no synced graph is open.
 */
import type { GraphStatus, StatusCallout } from './graph-status'

export interface HeaderGraphStatus {
    status: Extract<GraphStatus, { shown: true }>
    /** The notice to show beside the dot, already less whatever the person closed. */
    callout: StatusCallout | null
    open: () => void
    dismissCallout: () => void
}

let published = $state.raw<HeaderGraphStatus | null>(null)

export const headerGraphStatus = {
    get current(): HeaderGraphStatus | null {
        return published
    },
    set(next: HeaderGraphStatus | null): void {
        published = next
    },
}
