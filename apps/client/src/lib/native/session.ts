/**
 * The managed sign-in of a Native App: the seam between the Client and the shell's `auth.*` calls.
 *
 * In a browser the Client's server keeps the refresh token and hands out access tokens. An installed
 * app has no server, so its shell does both. Every function here answers null or false in a browser.
 */
import type { AccessTokenGrant } from '@appsoftwareltd/etherpk-native-bridge'

import { hasNativeFeature, nativeBridge } from './bridge.js'

/** Whether this Native App can sign in to the managed service. */
export function nativeSignInAvailable(): boolean {
    return hasNativeFeature('signIn')
}

/** A current access token, or null when nobody is signed in or there is no shell to ask. */
export async function nativeAccessToken(options: { forceRefresh?: boolean } = {}): Promise<AccessTokenGrant | null> {
    const bridge = nativeBridge()
    if (!bridge || !nativeSignInAvailable()) return null
    return bridge.call('auth.accessToken', options)
}

/** Whether someone is signed in to the managed service in this Native App. Asks nothing of the network. */
export async function nativeSessionAvailable(): Promise<boolean> {
    const bridge = nativeBridge()
    if (!bridge || !nativeSignInAvailable()) return false
    return bridge.call('auth.signedIn', {})
}

/** Sign in through the system browser. Rejects with `AbortError` when the person gives up. */
export async function nativeSignIn(): Promise<AccessTokenGrant> {
    const bridge = nativeBridge()
    if (!bridge) throw new DOMException('There is no shell to sign in with.', 'NotSupportedError')
    return bridge.call('auth.signIn', {})
}

/** Sign out of the managed service in this Native App. */
export async function nativeSignOut(): Promise<void> {
    await nativeBridge()?.call('auth.signOut', {})
}
