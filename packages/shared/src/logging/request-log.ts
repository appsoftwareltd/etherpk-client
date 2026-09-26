/**
 * The request line and the unexpected-error hook every EtherPK server writes, in one place:
 * Corporate, the Sync Server and the Client all install both.
 *
 * - `handleError` logs only a 5xx. SvelteKit also calls it for a plain 404, which the request
 *   line has already recorded at info; logging that again at error would put every
 *   `/favicon.ico` and bot probe in the error stream.
 * - The path is redacted before it is logged, because Better Auth's password-reset link carries
 *   its token in the path.
 */
import type { HandleServerError, RequestEvent } from '@sveltejs/kit'
import type { AppLogger } from './better-auth-logger'
import { redactPath, redactQueryString, redactUrl, shouldCaptureErrorResponseBody } from './redaction'

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RequestLogContext {
    logger: AppLogger
    /** The pod or container name, so a line can be traced to the replica that wrote it. */
    hostname: string
}

/**
 * The level a request line is written at. The rule an operator can alert on is "error means the
 * server failed": 5xx only. A 429 stays at warn because a burst of them is how a shared
 * rate-limit key shows itself. Every other refusal (401, 403, 404) is routine and goes in at
 * info, still visible under the default `LOG_LEVEL`. The health probe runs every few seconds and
 * would otherwise be most of the log, so a passing one drops to debug.
 */
export function requestLogLevel(method: string, path: string, status: number): RequestLogLevel {
    if (status >= 500) return 'error'
    if (status === 429) return 'warn'
    if (status >= 400) return 'info'
    if (method === 'GET' && path === '/health') return 'debug'
    return 'info'
}

/**
 * The client address the adapter resolved, or `undefined`. `getClientAddress()` throws outside a
 * real request (a build) and when `ADDRESS_HEADER` names a header the request does not carry; a
 * log line must not fail for either.
 */
export function safeClientAddress(event: Pick<RequestEvent, 'getClientAddress'>): string | undefined {
    try {
        return event.getClientAddress()
    } catch {
        return undefined
    }
}

/**
 * The signed-in user, when the app's `handle` has put one in `locals`. Corporate and the Sync
 * Server keep a Better Auth user there; the Client has none, so this is read loosely.
 */
function localUserId(event: RequestEvent): string | undefined {
    const locals = event.locals as { user?: { id?: unknown } | null }
    return typeof locals.user?.id === 'string' ? locals.user.id : undefined
}

/**
 * Write the one line every request gets, at the level {@link requestLogLevel} chooses. Path,
 * query and redirect target are redacted; an API error body is attached for diagnosis except on
 * `/api/auth/**`, whose bodies carry account detail.
 */
export async function logRequest(
    context: RequestLogContext,
    event: RequestEvent,
    response: Response,
    detail: { durationMs: number; userId?: string },
): Promise<void> {
    const path = event.url.pathname
    const line: Record<string, unknown> = {
        method: event.request.method,
        path: redactPath(path),
        status: response.status,
        duration_ms: Math.round(detail.durationMs),
        ip: safeClientAddress(event),
        userAgent: event.request.headers.get('user-agent') ?? undefined,
        query: redactQueryString(event.url.search),
        userId: detail.userId ?? localUserId(event),
        hostname: context.hostname,
    }
    // The redirect target, for OAuth hops and auth guards. It can carry a code or a document name.
    if (response.status >= 300 && response.status < 400) {
        line.location = redactUrl(response.headers.get('location'))
    }
    if (response.status >= 400 && shouldCaptureErrorResponseBody(path)) {
        Object.assign(line, await errorBodyFields(response))
    }
    context.logger[requestLogLevel(event.request.method, path, response.status)]('HTTP request', line)
}

/**
 * The error body, parsed when it is JSON, plus its message lifted to `errorDetail` for filtering
 * in OpenObserve. Read from a clone so the response still reaches the browser intact.
 */
async function errorBodyFields(response: Response): Promise<Record<string, unknown>> {
    let body: unknown
    try {
        const text = await response.clone().text()
        if (!text) return {}
        try { body = JSON.parse(text) } catch { body = text }
    } catch {
        return {} // a body that cannot be read is simply left out
    }
    if (typeof body === 'string') return { responseBody: body, errorDetail: body }
    const fields = body as Record<string, unknown>
    return {
        responseBody: body,
        errorDetail: fields.message ?? fields.error ?? fields.statusMessage ?? undefined,
    }
}

/**
 * SvelteKit's `handleError`: called for an unexpected error in a load, action or endpoint, and for
 * a route that does not exist. Only a 5xx is logged, at error with its stack; a 404 or 405 is
 * already on the request line at info, and logging it again as an error would make the error
 * stream useless for alerting. The visitor never sees the error's own text.
 */
export function createHandleError(context: RequestLogContext): HandleServerError {
    return ({ error, event, status }) => {
        if (status >= 500) {
            context.logger.error('Unexpected server error', {
                status,
                method: event.request.method,
                path: redactPath(event.url.pathname),
                query: redactQueryString(event.url.search),
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                ip: safeClientAddress(event),
                userAgent: event.request.headers.get('user-agent') ?? undefined,
                userId: localUserId(event),
                hostname: context.hostname,
            })
        }
        return { message: status === 404 ? 'Page not found' : 'Something went wrong' }
    }
}
