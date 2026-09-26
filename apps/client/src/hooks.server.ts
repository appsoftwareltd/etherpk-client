import type { Handle, RequestEvent } from '@sveltejs/kit'
import { hostname } from 'node:os'
import { building } from '$app/environment'
import { applySecurityHeaders } from '@appsoftwareltd/etherpk-shared'
import { createHandleError, logRequest } from '@appsoftwareltd/etherpk-shared/server/request-log'
import { env } from '$env/dynamic/private'
import { initLoggerFromEnv, logger, shutdownLogger } from '$lib/server/logger'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    clearManagedCookies,
    isClientSsoChecked,
    isClientSsoSuppressed,
    takeClientSsoAttempted,
} from '$lib/server/auth/cookies'
import {
    managedClientSsoCheckResponse,
    shouldAttemptManagedClientSso,
} from '$lib/server/auth/managed-routing'
import {
    decryptSessionCookie,
    isManagedSession,
    MANAGED_SESSION_COOKIE,
} from '$lib/server/auth/session-cookie'
import { SETTINGS_COOKIE_NAME, parseSettings } from '$lib/settings'
import {
    THEME_COOKIE_NAME,
    decorateHtmlWithTheme,
    normalizeThemePreference,
    resolveTheme,
} from '@appsoftwareltd/etherpk-shared/theme'
import { buildStampComment, decorateHtmlWithBuildStamp } from '@appsoftwareltd/etherpk-shared/build-stamp'

// Which build is serving this page: the first line of every page source, so `view-source:`
// answers it against `git log` without a shell on the box (see build-stamp.ts).
const buildStamp = buildStampComment('etherpk-client', __BUILD_INFO__)

const appHostname = hostname()

// The same structured logger Corporate and the Sync Server use. With OPENOBSERVE_URL unset, as
// on a standalone deployment, it writes JSON lines to stdout only.
initLoggerFromEnv({
    logLevel: env.LOG_LEVEL,
    openObserveUrl: env.OPENOBSERVE_URL,
    openObserveAuth: env.OPENOBSERVE_AUTH,
})

// adapter-node closes the server on SIGTERM or SIGINT and then emits 'sveltekit:shutdown'. The
// process exits once nothing is pending, so the last OpenObserve batch ships first. Registered
// once per process: a module re-evaluated by Vite's HMR must not add a second listener.
const LOGGER_SHUTDOWN_HOOKED = Symbol.for('etherpk.client.logger-shutdown')
const processGlobals = globalThis as unknown as Record<symbol, boolean | undefined>
if (!building && !processGlobals[LOGGER_SHUTDOWN_HOOKED]) {
    processGlobals[LOGGER_SHUTDOWN_HOOKED] = true
    process.once('sveltekit:shutdown', () => void shutdownLogger())
}

/**
 * Unexpected errors and missing routes. Only a 5xx is logged, at error with its stack; the rest
 * are on the request line. Replaces SvelteKit's default, which prints ANSI-coloured text such
 * as '[404] GET /favicon.ico' into an otherwise JSON log.
 */
export const handleError = createHandleError({ logger, hostname: appHostname })

/** One JSON request line per request that reaches the server (static assets never do). */
export const handle: Handle = async ({ event, resolve }) => {
    const start = performance.now()
    const response = await respond(event, resolve)
    await logRequest({ logger, hostname: appHostname }, event, response, { durationMs: performance.now() - start })
    return response
}

async function respond(event: RequestEvent, resolve: Parameters<Handle>[0]['resolve']): Promise<Response> {
    const themePreference = normalizeThemePreference(event.cookies.get(THEME_COOKIE_NAME))
    const systemPrefersDark = event.request.headers.get('sec-ch-prefers-color-scheme') === 'dark'
    const resolvedTheme = resolveTheme(themePreference, systemPrefersDark)

    event.locals.themePreference = themePreference
    event.locals.resolvedTheme = resolvedTheme
    // Chrome settings (sidebar collapsed, …) read server-side so the workspace
    // renders the correct collapsed state without a first-paint flash.
    event.locals.settings = parseSettings(event.cookies.get(SETTINGS_COOKIE_NAME))

    const managedAuthConfig = parseOptionalManagedClientAuthConfig(env)
    let managedSessionAvailable = false
    if (managedAuthConfig) {
        const encryptedSession = event.cookies.get(MANAGED_SESSION_COOKIE)
        if (encryptedSession) {
            try {
                const session = await decryptSessionCookie<unknown>(
                    encryptedSession,
                    managedAuthConfig.sessionSecret,
                    'managed-session',
                )
                managedSessionAvailable = isManagedSession(session) && session.expiresAt > Date.now()
            } catch {
                managedSessionAvailable = false
            }
            if (!managedSessionAvailable) clearManagedCookies(event.cookies, managedAuthConfig)
        }
    }
    event.locals.managedSessionAvailable = managedSessionAvailable

    const attempted = takeClientSsoAttempted(event.cookies)
    if (shouldAttemptManagedClientSso({
        configured: managedAuthConfig !== null,
        method: event.request.method,
        pathname: event.url.pathname,
        acceptsHtml: event.request.headers.get('accept')?.includes('text/html') ?? false,
        sessionAvailable: managedSessionAvailable,
        suppressed: isClientSsoSuppressed(event.cookies),
        attempted,
        checked: isClientSsoChecked(event.cookies),
        arrivedFromAnotherOrigin: ['same-site', 'cross-site'].includes(event.request.headers.get('sec-fetch-site') ?? ''),
    })) {
        return managedClientSsoCheckResponse(event.url)
    }

    const response = await resolve(event, {
        transformPageChunk: ({ html }) =>
            decorateHtmlWithBuildStamp(
                decorateHtmlWithTheme(html, themePreference, resolvedTheme),
                buildStamp,
            ),
    })

    response.headers.set('Accept-CH', 'Sec-CH-Prefers-Color-Scheme')
    // The CSP itself comes from kit.csp, which is the only thing that can nonce SvelteKit's
    // own inline scripts. Everything static is set here.
    applySecurityHeaders(response, { https: event.url.protocol === 'https:' })
    return response
}
