/**
 * The Sync Server a Native App's person set in place of the one the app was built with (ADR 0214),
 * as the shell hands it over in `ShellInfo.syncServer`. Read once, as the bridge is.
 *
 * The page checks it again: a value that is not an origin it may reach is logged and passed over,
 * so the app opens as it was built rather than connecting somewhere nobody wrote.
 */
import { isSyncServerOrigin, type ShellInfo } from '@appsoftwareltd/etherpk-native-bridge'

import { nativeBridge } from './bridge.js'

/** Exported for tests. Null in a browser, and where the shell names no server. */
export function shellSyncServerOf(info: ShellInfo | null): string | null {
    const server = info?.syncServer
    if (server === undefined || server === null) return null
    if (isSyncServerOrigin(server)) return server
    console.error('The app\'s shell named a Sync Server that is not an origin the page can use, so the app opens as it was built.', server)
    return null
}

const server = shellSyncServerOf(nativeBridge()?.info ?? null)

/** The Sync Server the shell names, or null. */
export function shellSyncServer(): string | null {
    return server
}
