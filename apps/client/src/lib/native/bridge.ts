/**
 * The Client's end of the Native Bridge: what a Native App's shell can do for the page, and
 * null in a browser, where every caller uses the web platform.
 *
 * The shell puts its port on `window` before any of the page's scripts run, so it is read once, when
 * this module is first imported. Reading it once also means a script that runs later cannot put a
 * port of its own in place of the shell's.
 */
import {
    connectNativeBridge,
    NATIVE_PORT_NAME,
    type NativeBridge,
    type NativePort,
    type ShellFeatures,
    type ShellPlatform,
} from '@appsoftwareltd/etherpk-native-bridge'

/**
 * A port on this object, connected, or null when there is none.
 *
 * Exported for tests. Throws when the shell and the page speak different versions of the bridge,
 * because the page was packaged with the shell and neither can work around the other.
 */
export function bridgeOn(host: object | undefined): NativeBridge | null {
    const port = (host as { [NATIVE_PORT_NAME]?: NativePort } | undefined)?.[NATIVE_PORT_NAME]
    return port ? connectNativeBridge(port) : null
}

// The server renders pages too, and has no window.
const bridge = bridgeOn(typeof window === 'undefined' ? undefined : window)

/** The shell of the Native App this page runs in. Null in a browser and on the server. */
export function nativeBridge(): NativeBridge | null {
    return bridge
}

/** Whether this page runs in a Native App, which has no server of its own to ask for anything. */
export function isNativeApp(): boolean {
    return bridge !== null
}

/** The system the Native App runs on. Null in a browser. */
export function nativePlatform(): ShellPlatform | null {
    return bridge?.info.platform ?? null
}

/** Whether this shell has an optional feature. False in a browser. */
export function hasNativeFeature(feature: keyof ShellFeatures): boolean {
    return bridge?.info.features[feature] ?? false
}

/** The Native App's release. Null in a browser. */
export function nativeAppVersion(): string | null {
    return bridge?.info.appVersion ?? null
}
