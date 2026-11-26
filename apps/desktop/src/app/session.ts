/** What every page of the app's session may reach, and how servers see it. */
import type { Session } from 'electron'
import { DESKTOP_APP_ORIGIN } from '@appsoftwareltd/etherpk-native-bridge'
import { InstalledBuild } from '../web/installed-build.ts'
import { PresentedOrigin } from '../web/origin.ts'
import { isAllowed } from '../web/rules.ts'

export const SCHEME = new URL(DESKTOP_APP_ORIGIN).protocol.slice(0, -1)
const HOST = DESKTOP_APP_ORIGIN.slice(`${SCHEME}://`.length)

/** Told to Electron before it is ready: what makes `app://etherpk` an origin like any https one. */
export const SCHEME_PRIVILEGES = {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true, stream: true, codeCache: true },
}

const EVERYTHING = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }

/**
 * Whether a request is for a page. Electron gives the handler neither the mode nor the destination, and
 * the `Accept` of a navigation is one no other request of the Client's has.
 */
function isNavigation(request: Request): boolean {
    return request.headers.get('accept')?.startsWith('text/html,application/xhtml+xml') ?? false
}

export function serveInstalledBuild(session: Session, build: InstalledBuild): void {
    session.protocol.handle(SCHEME, (request) => {
        const url = new URL(request.url)
        if (url.host !== HOST) return new Response('Not found', { status: 404 })
        return build.answer({ method: request.method, url: request.url, navigation: isNavigation(request) })
    })
}

export function presentOrigin(session: Session): PresentedOrigin {
    const presented = new PresentedOrigin()
    session.webRequest.onBeforeSendHeaders(EVERYTHING, (details, answer) => answer({ requestHeaders: presented.outgoing(details) }))
    session.webRequest.onHeadersReceived(EVERYTHING, (details, answer) => answer({ responseHeaders: presented.incoming(details) }))
    session.webRequest.onCompleted(EVERYTHING, ({ id }) => presented.ended(id))
    session.webRequest.onErrorOccurred(EVERYTHING, ({ id }) => presented.ended(id))
    return presented
}

export function limitPermissions(session: Session, log: (message: string, error?: unknown) => void): void {
    session.setPermissionRequestHandler((_contents, permission, answer, details) => {
        answer(isAllowed({ permission, isMainFrame: details.isMainFrame, origin: originOf(details.requestingUrl) }))
    })
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => isAllowed({ permission, isMainFrame: details.isMainFrame, origin: requestingOrigin }))
    session.setDevicePermissionHandler(() => false)
    // Saving a file goes through the port, where the person says where. Nothing else writes one.
    session.on('will-download', (event, item) => {
        event.preventDefault()
        log('A download was refused.', item.getURL().slice(0, 200))
    })
    session.setSpellCheckerEnabled(false)
}

function originOf(url: string): string {
    if (!URL.canParse(url)) return ''
    const { protocol, host } = new URL(url)
    return `${protocol}//${host}`
}
