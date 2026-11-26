/**
 * The origin servers see. The app's pages are at `app://etherpk`, which no server lists, so a request
 * they make to a server says it comes from the Native Apps' own https origin.
 *
 * Cross-origin rules stay the browser's. Only an answer that names exactly the origin presented is
 * given the page's own in its place, and only for a request that presented it. An answer that names
 * another origin, or none, is refused as it always was, and `*` is left as it is, since the browser gives
 * it less than a name (no credentials).
 */
import { DESKTOP_APP_ORIGIN, INSTALLED_APP_ORIGIN } from '@appsoftwareltd/etherpk-native-bridge'

type RequestHeaders = Record<string, string>
type ResponseHeaders = Record<string, string[]>

function headerName(headers: Record<string, unknown>, name: string): string | undefined {
    return Object.keys(headers).find((key) => key.toLowerCase() === name)
}

/** Video players that refuse to play with no address of the page they are in. */
const PLAYER_HOSTS = new Set(['www.youtube-nocookie.com', 'player.vimeo.com'])

export class PresentedOrigin {
    /** Requests of the app's own pages that are on their way. */
    private readonly presented = new Set<number>()

    outgoing(request: { id: number; url: string; resourceType: string; requestHeaders: RequestHeaders }): RequestHeaders {
        const headers = { ...request.requestHeaders }
        const origin = headerName(headers, 'origin')
        // Asked again on each redirect, where the browser may have taken the origin away.
        if (origin !== undefined && headers[origin] === DESKTOP_APP_ORIGIN) {
            headers[origin] = INSTALLED_APP_ORIGIN
            this.presented.add(request.id)
        } else {
            this.presented.delete(request.id)
        }
        if (request.resourceType === 'subFrame' && headerName(headers, 'referer') === undefined && PLAYER_HOSTS.has(hostOf(request.url))) {
            headers.Referer = `${INSTALLED_APP_ORIGIN}/`
        }
        return headers
    }

    incoming(response: { id: number; responseHeaders?: ResponseHeaders }): ResponseHeaders | undefined {
        const headers = response.responseHeaders
        if (!headers || !this.presented.has(response.id)) return headers
        const names = Object.keys(headers).filter((key) => key.toLowerCase() === 'access-control-allow-origin')
        const [name] = names
        if (names.length !== 1 || headers[name].length !== 1 || headers[name][0] !== INSTALLED_APP_ORIGIN) return headers
        return { ...headers, [name]: [DESKTOP_APP_ORIGIN] }
    }

    ended(id: number): void {
        this.presented.delete(id)
    }

    get size(): number {
        return this.presented.size
    }
}

function hostOf(url: string): string {
    return URL.canParse(url) ? new URL(url).hostname : ''
}
