/**
 * Which client address Better Auth's rate limits key on.
 *
 * Left to its defaults, better-auth 1.6.15 takes the first `X-Forwarded-For` entry, which behind a
 * proxy that appends to that header (nginx's `$proxy_add_x_forwarded_for`, Nginx Proxy Manager,
 * Cloudflare) is the value the browser sent, and it applies no limit when it finds no address. Nor
 * do its defaults read the adapter's own setting, `ADDRESS_HEADER`, which the Registration Policy
 * and the request log honour.
 *
 * So the address is resolved once, by the SvelteKit adapter (`getClientAddress()`, which applies
 * `ADDRESS_HEADER` and `XFF_DEPTH`, or else uses the socket peer), and stamped onto the request
 * under a header of our own before Better Auth sees it. Better Auth is told to read only that
 * header. One setting governs the log, the Registration Policy and the auth rate limits.
 */
import type { AppLogger } from '../logging/better-auth-logger'

/** The header Better Auth reads the client address from. Set here; never trusted from outside. */
export const AUTH_CLIENT_ADDRESS_HEADER = 'x-etherpk-client-address'

/** Better Auth's `advanced.ipAddress`: read only the stamped header. */
export const AUTH_IP_ADDRESS_OPTIONS = { ipAddressHeaders: [AUTH_CLIENT_ADDRESS_HEADER] }

/**
 * Stands for "the adapter could not say". Better Auth skips rate limiting for a request without a
 * valid address, so an unresolved request instead shares this one bucket: failing closed, and
 * loudly, rather than open and silently.
 */
export const UNRESOLVED_CLIENT_ADDRESS = '0.0.0.0'

/** Headers a reverse proxy or CDN adds. Any of them means the socket peer is not the visitor. */
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']

/** How often an unresolved address is reported. Every auth request would otherwise log it. */
const UNRESOLVED_WARNING_INTERVAL_MS = 60_000

export interface ClientAddressSettings {
    /** adapter-node's `ADDRESS_HEADER`, as the deployment set it. */
    addressHeader: string | undefined
    /** A production server. The Vite development server ignores `ADDRESS_HEADER` altogether. */
    production: boolean
}

/**
 * Build the function a `handle` hook calls on each `/api/auth/**` request before Better Auth runs.
 * It mutates the request's headers in place: Better Auth reads the same `Request` object that
 * SvelteKit's handler passes on, and a request from adapter-node carries mutable headers.
 */
export function createAuthClientAddressStamp(logger: AppLogger) {
    let proxyWarningGiven = false
    let lastUnresolvedWarningAt = Number.NEGATIVE_INFINITY

    return function stampAuthClientAddress(
        request: Request,
        clientAddress: string | undefined,
        settings: ClientAddressSettings,
    ): void {
        request.headers.delete(AUTH_CLIENT_ADDRESS_HEADER)
        request.headers.set(AUTH_CLIENT_ADDRESS_HEADER, clientAddress ?? UNRESOLVED_CLIENT_ADDRESS)

        if (clientAddress === undefined) {
            const now = Date.now()
            if (now - lastUnresolvedWarningAt >= UNRESOLVED_WARNING_INTERVAL_MS) {
                lastUnresolvedWarningAt = now
                logger.warn('auth client address unresolved; sharing one rate-limit bucket', {
                    addressHeader: settings.addressHeader ?? null,
                })
            }
            return
        }

        if (settings.production && !settings.addressHeader && !proxyWarningGiven) {
            const proxyHeaders = PROXY_HEADERS.filter((name) => request.headers.has(name))
            if (proxyHeaders.length > 0) {
                proxyWarningGiven = true
                logger.warn(
                    'requests arrive through a proxy but ADDRESS_HEADER is unset; every client shares the proxy address',
                    { proxyHeaders, resolvedAddress: clientAddress },
                )
            }
        }
    }
}
