/**
 * Signing in to another service from an extension (`context.auth`, ADR 0140).
 *
 * An extension opens the service's sign-in address in a popup (`authorize`), and the service sends
 * the popup back to the Client's one return page, `/extension-sign-in`
 * (`routes/extension-sign-in`). That page reads what came back and passes it on over a
 * `BroadcastChannel`, and the sign-in waiting for the same `state` takes it and closes the popup.
 *
 * A channel rather than `window.opener`: a sign-in page that sends `Cross-Origin-Opener-Policy`
 * cuts the popup off from the window that opened it, for good, and Google's sign-in pages already
 * report one (`same-origin`, report-only, checked 2026-10-12). A channel reaches every page of
 * the Client's origin whatever the popup went through. For the same reason the Client cannot tell
 * a popup the person closed from one that was cut off, so a sign-in is never failed for a closed
 * popup: the extension offers a way to give up (`signal`), and a sign-in left alone gives up after
 * ten minutes.
 *
 * Every page of the origin hears the channel, which is no wider than the reach every extension
 * already has: extensions run unsandboxed in the Client's page.
 */
import type { AuthorizeOptions, ExtensionAuth } from '@appsoftwareltd/etherpk-extension-api'

/** The Client's one return page for every extension's sign-in. */
export const SIGN_IN_PATH = '/extension-sign-in'

/** The channel the return page passes a sign-in's answer on over. */
export const SIGN_IN_CHANNEL = 'etherpk:extension-sign-in'

/** How long a sign-in may take before it is given up. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

/** The part of a BroadcastChannel a sign-in uses. */
export interface SignInChannel {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage(data: unknown): void
    close(): void
}

/** The part of a popup window a sign-in uses. */
export interface SignInPopup {
    close(): void
}

export interface ExtensionSignInOptions {
    /** The Client's origin, such as `https://app.etherpk.com`. */
    origin: string
    /** Open the sign-in address in a popup, or null when the browser blocked it. */
    openWindow(url: string): SignInPopup | null
    /** A channel by name: a BroadcastChannel in the browser. */
    channel(name: string): SignInChannel
}

/** What the return page passes on: the parameters the service sent back. */
interface SignInMessage {
    parameters: Record<string, string>
}

function isSignInMessage(data: unknown): data is SignInMessage {
    if (typeof data !== 'object' || data === null) return false
    const parameters = (data as { parameters?: unknown }).parameters
    return typeof parameters === 'object' && parameters !== null && Object.values(parameters).every((value) => typeof value === 'string')
}

/** Whether a sign-in may be sent to `url`: https, or plain http to this device while developing. */
function allowedAddress(url: URL): boolean {
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

export function createExtensionSignIn(options: ExtensionSignInOptions): ExtensionAuth {
    return {
        redirectUri: `${options.origin}${SIGN_IN_PATH}`,
        authorize(address: string, authorizeOptions: AuthorizeOptions = {}): Promise<Record<string, string>> {
            let url: URL
            try {
                url = new URL(address)
            } catch {
                return Promise.reject(new Error('The sign-in address must carry a state parameter.'))
            }
            if (!allowedAddress(url)) return Promise.reject(new Error('The sign-in address must be an https address.'))
            const state = url.searchParams.get('state')
            if (!state) return Promise.reject(new Error('The sign-in address must carry a state parameter.'))
            const { signal } = authorizeOptions
            if (signal?.aborted) return Promise.reject(new Error('The sign-in was cancelled.'))

            // Opened now, inside the click that asked for it: a browser blocks a popup opened later.
            const popup = options.openWindow(url.href)
            if (!popup) return Promise.reject(new Error('The browser blocked the sign-in window. Allow pop-ups for this site, then try again.'))

            return new Promise((resolve, reject) => {
                const channel = options.channel(SIGN_IN_CHANNEL)
                const finish = () => {
                    clearTimeout(timer)
                    signal?.removeEventListener('abort', aborted)
                    channel.onmessage = null
                    channel.close()
                    try {
                        popup.close()
                    } catch {
                        // A popup cut off from this window cannot be closed from here: the return page closes itself.
                    }
                }
                const aborted = () => {
                    finish()
                    reject(new Error('The sign-in was cancelled.'))
                }
                const timer = setTimeout(() => {
                    finish()
                    reject(new Error('The sign-in took too long. Try again.'))
                }, SIGN_IN_TIMEOUT_MS)
                signal?.addEventListener('abort', aborted)
                channel.onmessage = (event) => {
                    if (!isSignInMessage(event.data) || event.data.parameters.state !== state) return
                    finish()
                    resolve({ ...event.data.parameters })
                }
            })
        },
    }
}

/**
 * The parameters a service sent the return page back with: its query, and its fragment, which a
 * service answering in the fragment uses. Where both name a parameter, the fragment's is taken.
 */
export function readReturnParameters(url: URL): Record<string, string> {
    const parameters: Record<string, string> = {}
    for (const [key, value] of url.searchParams) parameters[key] = value
    for (const [key, value] of new URLSearchParams(url.hash.slice(1))) parameters[key] = value
    return parameters
}

/** The sign-in service for this page: popups opened by `window.open`, answers over a BroadcastChannel. */
export function browserSignIn(): ExtensionAuth {
    return createExtensionSignIn({
        // Built during server rendering too, where nothing signs in.
        origin: typeof location === 'undefined' ? '' : location.origin,
        // Sized like the sign-in pages services draw. `popup` asks for a separate small window; a
        // browser that will not make one opens a tab, which works the same.
        openWindow: (url) => window.open(url, '_blank', 'popup,width=520,height=680'),
        channel: (name) => new BroadcastChannel(name),
    })
}
