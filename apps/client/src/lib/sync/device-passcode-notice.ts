/**
 * The notice that offers a Device Passcode (ADR 0129), said once per device: the first time a
 * synced graph opens on a device with no passcode. The flag is set when the notice shows, so
 * closing the tab without answering does not bring it back; the Graphs page's This Device tab
 * offers a passcode from then on, and marks the tab while none is set.
 */

const KEY = 'etherpk.device-passcode-notice-shown'

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
