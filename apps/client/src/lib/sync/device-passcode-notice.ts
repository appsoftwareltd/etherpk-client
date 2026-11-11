/**
 * The notice that offers a Device Passcode (ADR 0129), said once per device: the first time a
 * synced graph opens on a device with no passcode. The flag is set when the notice shows, so
 * closing the tab without answering does not bring it back; the Graphs page's This Device tab
 * offers a passcode from then on, and marks the tab while none is set.
 */
import type { DevicePasscodeState } from './device-passcode'

const KEY = 'etherpk.device-passcode-notice-shown'

/** What the mark reads of a Sync Server this device holds (a `SyncServerView` fits). */
export interface HeldServerSecrets {
    connection: { kind: 'managed' | 'custom' }
    /** This device holds the Encryption Keys of the account on this server. */
    vaultUnlocked: boolean
}

/**
 * Whether the This Device tab marks a Device Passcode as not set: none is set, and this device
 * stores something one would encrypt. That is a server's Encryption Keys, or a custom server's
 * access token, which is stored from the moment the server is added. Managed Sync held with no
 * keys stores neither (its credential is the Client's session), so a browser that only started a
 * sign-in, or signed out, carries no mark.
 */
export function devicePasscodeMarkDue(passcode: DevicePasscodeState, servers: readonly HeldServerSecrets[]): boolean {
    if (passcode !== 'off') return false
    return servers.some((server) => server.vaultUnlocked || server.connection.kind === 'custom')
}

/** True when this device has already been shown the notice. */
export function devicePasscodeNoticeShown(): boolean {
    try {
        return localStorage.getItem(KEY) === '1'
    } catch {
        // Storage refused (private mode): better to say nothing than to say it on every open.
        return true
    }
}

export function markDevicePasscodeNoticeShown(): void {
    try {
        localStorage.setItem(KEY, '1')
    } catch {
        // Nothing to do: the notice cannot be remembered here.
    }
}
