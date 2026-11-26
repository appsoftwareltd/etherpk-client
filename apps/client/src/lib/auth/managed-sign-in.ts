/**
 * Signing in to EtherPK and out of it, from any button or link of the Client.
 *
 * In a browser the Client's server does both, and the page leaves for it. An installed app has no
 * server: its shell opens the system browser, keeps the sign-in and answers with an access token, and
 * the page stays where it is.
 */
import { dismissNotice, showNotice } from '#lib/activity/notices.js'
import { isNativeApp } from '#lib/native/bridge.js'
import { nativeSignIn, nativeSignInAvailable, nativeSignOut } from '#lib/native/session.js'
import { safeReturnPath } from '@appsoftwareltd/etherpk-shared'
import { clearManagedAccessToken, holdManagedAccessToken } from './managed-token'
import { currentReturnPath, managedSignInHref } from './sign-in-links'

const NOTICE = 'managed-sign-in'

/** `leaving`: the page is on its way to the sign-in. */
export type SignInResult = 'leaving' | 'signed-in' | 'not-signed-in'

interface SignInParts {
    navigate?: (path: string) => void
    /** The page the person is on. */
    here?: string
    /** What else the page does once signed in, before any page is loaded again. */
    signedIn?: () => void
}

const go = (path: string) => window.location.assign(path)

/**
 * Whether a page was drawn for someone signed out and has to load again: the list of graphs, and a
 * synced graph that could not open or stopped. A folder graph goes on as it is.
 */
export function loadsAgainAfterSignIn(path: string): boolean {
    return /^\/graphs(?:[/?#]|$)/.test(path) || path.startsWith('/graph/sync/')
}

/** The newest sign-in. A sign-in begun while another waits replaces it, and the replaced one says nothing more. */
let newest = 0

/** Sign in, ending on `returnPath`. */
export async function signInToEtherPK(returnPath: string | null | undefined, parts: SignInParts = {}): Promise<SignInResult> {
    const navigate = parts.navigate ?? go
    if (!isNativeApp()) {
        navigate(managedSignInHref(returnPath))
        return 'leaving'
    }
    if (!nativeSignInAvailable()) {
        showFailure('NotSupportedError')
        return 'not-signed-in'
    }
    if (!(await signInThroughShell())) return 'not-signed-in'
    parts.signedIn?.()
    goOnAfterSignIn(returnPath, parts.here ?? currentReturnPath(window.location), navigate)
    return 'signed-in'
}

/** Whether the shell signed someone in. Says so to the person while it waits, and in words when it fails. */
async function signInThroughShell(): Promise<boolean> {
    const attempt = ++newest
    showNotice({
        id: NOTICE,
        tone: 'info',
        dismissal: 'manual',
        text: 'Finish signing in in your browser, then come back to EtherPK. If the browser did not open, select Sign in again.',
    })
    try {
        holdManagedAccessToken(await nativeSignIn())
    } catch (error) {
        if (attempt === newest) {
            dismissNotice(NOTICE)
            const name = error instanceof DOMException ? error.name : 'OperationError'
            if (name !== 'AbortError') {
                console.error('[sign-in] the sign-in failed', error)
                showFailure(name)
            }
        }
        return false
    }
    if (attempt === newest) dismissNotice(NOTICE)
    return true
}

/** To the page the sign-in was for, when it is another, or this one drawn signed out. */
function goOnAfterSignIn(returnPath: string | null | undefined, here: string, navigate: (path: string) => void): void {
    const path = safeReturnPath(returnPath ?? null, '')
    if (path && (path !== here || loadsAgainAfterSignIn(path))) navigate(path)
}

function showFailure(name: string): void {
    const text = name === 'NetworkError'
        ? 'The EtherPK account site could not be reached. Check your connection, then sign in again.'
        : name === 'NotSupportedError'
          ? 'This version of the app does not sign in to EtherPK. Use EtherPK in a browser, or connect to your own Sync Server.'
          : 'The sign-in was not completed. Sign in again.'
    showNotice({ id: NOTICE, tone: 'error', text })
}

/**
 * The click handler of a link to the sign-in (`managedSignInHref`). In a browser the link is followed.
 */
export function managedSignInOnClick(returnPath: string | null | undefined, parts: SignInParts = {}): (event: MouseEvent) => void {
    return (event) => {
        if (!isNativeApp()) return
        event.preventDefault()
        void signInToEtherPK(returnPath, parts)
    }
}

/**
 * End an installed app's sign-in. The token here goes first, whatever the shell answers: it also
 * forgets its own before it asks the account site to, and a failure to revoke there is its own to log.
 * So a refusal means the shell still holds the sign-in, which comes back when the app opens again:
 * the person is told, and the caller keeps showing them signed in. Answers whether it finished.
 */
export async function signOutOfInstalledApp(): Promise<boolean> {
    clearManagedAccessToken()
    try {
        await nativeSignOut()
        return true
    } catch (error) {
        console.error('[sign-in] the shell could not finish signing out', error)
        showNotice({
            id: 'native-sign-out',
            tone: 'error',
            text: 'EtherPK could not sign you out in this app, and you may still be signed in when it opens again. Try signing out again.',
        })
        return false
    }
}
