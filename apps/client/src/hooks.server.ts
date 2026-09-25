import type { Handle } from '@sveltejs/kit'
import { applySecurityHeaders } from '@appsoftwareltd/etherpk-shared'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import {
    clearManagedCookies,
    isClientSsoSuppressed,
    takeClientSsoAttempted,
} from '$lib/server/auth/cookies'
import {
    buildManagedClientSsoCheckUrl,
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

export const handle: Handle = async ({ event, resolve }) => {
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
    })) {
        return new Response(null, {
            status: 303,
            headers: { Location: buildManagedClientSsoCheckUrl(event.url) },
        })
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
