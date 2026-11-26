/**
 * What this build says it is when it opens a sync socket (`sync-client-info.ts` in the shared
 * package): the kind of Client and its release, and nothing about the person or the device.
 */
import { NATIVE_PORT_NAME } from '@appsoftwareltd/etherpk-native-bridge'
import type { SyncClientInfo } from '@appsoftwareltd/etherpk-shared'

/** Put in place of the name by Vite (apps/client/vite.config.ts). The Headless Client's build has none. */
declare const __BUILD_INFO__: { version: string } | undefined

let named: SyncClientInfo | undefined

/** For a program that runs the sync engine and is not the Client: the Headless Client. */
export function nameThisClient(info: SyncClientInfo | undefined): void {
    named = info
}

export function thisClient(): SyncClientInfo | null {
    if (named) return named
    if (typeof __BUILD_INFO__ === 'undefined') return null
    return { kind: NATIVE_PORT_NAME in globalThis ? 'installed' : 'web', version: __BUILD_INFO__.version }
}
