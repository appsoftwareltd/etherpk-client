/**
 * Every sign-in to an account with two-factor authentication on asks for the authenticator code,
 * whichever way it started, except a passkey (ADR 0182).
 *
 * Better Auth's two-factor plugin holds a password sign-in for the code. This after hook holds
 * every other new session the same way: a GitHub or Google sign-in, a Google ID token, an email
 * verification link, and any way of signing in added later, since it lists the routes that need
 * no code rather than the ones that do. The new session is deleted before the response leaves, and
 * the browser gets the pending sign-in the plugin gives a password (a signed `two_factor` cookie
 * naming a verification row), so the plugin's own routes finish it with a code or a backup code.
 *
 * The pending sign-in is written as better-auth 1.7's two-factor plugin writes its own
 * (`plugins/two-factor/index.mjs`): the cookie name, the verification identifiers and the
 * attempt counter are the plugin's. The apps' tests finish a held sign-in through the plugin's
 * verify route, so an upgrade that changes them fails there.
 *
 * The shared package does not depend on better-auth, so the hook's context is described below by
 * the parts this uses, and each app wraps the function in a plugin of its own (`second-factor.ts`).
 */
import { twoFactorStepPath } from '../auth/two-factor-step'

/** How long a held sign-in waits for its code: the two-factor plugin's default, ten minutes. */
const DEFAULT_CHALLENGE_SECONDS = 600

/** The routes that may create a session for an account with two-factor authentication on. */
const EXEMPT_ROUTES = new Set([
    // A passkey proves the device and the person who unlocks it, both factors in one step.
    '/passkey/verify-authentication',
    // The two-factor plugin holds these for the code itself.
    '/sign-in/email',
    '/sign-in/username',
    '/sign-in/phone-number',
    // An administrator acting as an account, and stopping, from a session already signed in.
    '/admin/impersonate-user',
    '/admin/stop-impersonating',
])

/** Whether a session `path` creates is let through without the code. */
export function isExemptFromSecondFactor(path: string): boolean {
    // The code step itself, and turning two-factor authentication on and off.
    return path.startsWith('/two-factor/') || EXEMPT_ROUTES.has(path)
}

/**
 * A redirect's target as a path on the auth server's own origin, or null for any other origin.
 * The sign-in page carries it as `redirect`, which takes a path only.
 */
export function pathOnThisOrigin(location: string, baseURL: string): string | null {
    const origin = new URL(baseURL).origin
    let url: URL
    try {
        url = new URL(location, origin)
    } catch {
        return null
    }
    return url.origin === origin ? url.pathname + url.search + url.hash : null
}

interface HookSession {
    session: { token: string; expiresAt: Date }
    user: { id: string; twoFactorEnabled?: boolean | null }
}

/** The parts of Better Auth's hook context (`createAuthMiddleware`) the hold uses. */
export interface SecondFactorHookContext<CookieAttributes> {
    path: string
    getSignedCookie(name: string, secret: string): Promise<string | null | false | undefined>
    setSignedCookie(name: string, value: string, secret: string, attributes?: CookieAttributes): Promise<unknown>
    redirect(url: string): unknown
    json(body: { twoFactorRedirect: true; twoFactorMethods: string[] }): unknown
    context: {
        /** The session the route has just created, if it created one. */
        newSession: HookSession | null
        setNewSession(session: null): void
        /** The session the request arrived with, once a route or middleware has read it. */
        session: { user: { id: string } } | null
        responseHeaders?: Headers
        baseURL: string
        secret: string
        authCookies: { sessionToken: { name: string } }
        createAuthCookie(name: string, overrides?: { maxAge?: number }): { name: string; attributes: CookieAttributes }
        getPlugin(id: 'two-factor'): { options?: { twoFactorCookieMaxAge?: number } } | null | undefined
        internalAdapter: {
            deleteSession(token: string): Promise<unknown>
            findSession(token: string): Promise<HookSession | null>
            createVerificationValue(data: { value: string; identifier: string; expiresAt: Date }): Promise<unknown>
        }
    }
}

export interface SecondFactorHoldOptions {
    /** The page whose code step finishes a held sign-in. */
    signInPage: string
    /** Expire the response's session cookies: Better Auth's `deleteSessionCookie(ctx, true)`. */
    clearSessionCookie(): void
    /**
     * Where a held sign-in goes once the code is in, when the app knows better than the route's
     * own redirect: Corporate resumes the OAuth authorization a GitHub or Google sign-in was
     * part of. Null leaves it to the route's redirect.
     */
    resumeAfterCode?(): Promise<string | null>
}

/**
 * The after hook. A new session for an account with two-factor authentication on becomes a
 * pending sign-in, unless the route is exempt or the request was already signed in to that
 * account (a password change that signs out other devices, a session's own refresh). A route that
 * redirects (a social callback, a verification link) sends the browser to the sign-in page's code
 * step instead, carrying on where it was going; one that answers JSON answers as a password
 * sign-in does, with `twoFactorRedirect`.
 */
export async function holdSignInForSecondFactor<CookieAttributes>(
    ctx: SecondFactorHookContext<CookieAttributes>,
    options: SecondFactorHoldOptions,
): Promise<unknown> {
    const created = ctx.context.newSession
    if (!created || !(await waitsForCode(ctx, created))) return undefined

    // Read before anything replaces the response.
    const location = ctx.context.responseHeaders?.get('location') ?? null
    const returnTo = await whereItWasGoing(ctx, location, options)

    options.clearSessionCookie()
    await ctx.context.internalAdapter.deleteSession(created.session.token)
    // Later hooks (the OAuth provider's resume among them) see no session, as after a password.
    ctx.context.setNewSession(null)
    await startPendingSignIn(ctx, created.user.id)

    if (location) throw ctx.redirect(twoFactorStepPath(options.signInPage, returnTo))
    return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] })
}

/** An account with the code turned on, a route that is not exempt, and no session for it already. */
async function waitsForCode<A>(ctx: SecondFactorHookContext<A>, created: HookSession): Promise<boolean> {
    if (created.user.twoFactorEnabled !== true || isExemptFromSecondFactor(ctx.path)) return false
    return !(await alreadySignedInAs(ctx, created.user.id))
}

/** Where the sign-in page goes once the code is in: the app's own resume, or the route's redirect. */
async function whereItWasGoing<A>(ctx: SecondFactorHookContext<A>, location: string | null, options: SecondFactorHoldOptions): Promise<string | null> {
    const resumed = await options.resumeAfterCode?.()
    if (resumed) return resumed
    return location ? pathOnThisOrigin(location, ctx.context.baseURL) : null
}

/** Whether the request arrived signed in to `userId`'s account. */
async function alreadySignedInAs<A>(ctx: SecondFactorHookContext<A>, userId: string): Promise<boolean> {
    // The session as the route read it at the start. A route that ends it, such as a password
    // change that signs out the other devices, has deleted it from the store by now.
    if (ctx.context.session) return ctx.context.session.user.id === userId
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)
    if (!token) return false
    const existing = await ctx.context.internalAdapter.findSession(token)
    return existing?.user.id === userId && new Date(existing.session.expiresAt).getTime() > Date.now()
}

/** The pending sign-in the two-factor plugin's verify routes finish, as the plugin writes it. */
async function startPendingSignIn<A>(ctx: SecondFactorHookContext<A>, userId: string): Promise<void> {
    const seconds = ctx.context.getPlugin('two-factor')?.options?.twoFactorCookieMaxAge ?? DEFAULT_CHALLENGE_SECONDS
    const cookie = ctx.context.createAuthCookie('two_factor', { maxAge: seconds })
    const identifier = `2fa-${randomToken()}`
    const expiresAt = new Date(Date.now() + seconds * 1000)
    await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt })
    // Wrong codes against this sign-in, which the plugin ends after five.
    await ctx.context.internalAdapter.createVerificationValue({ value: '0', identifier: `2fa-attempts-${identifier}`, expiresAt })
    await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes)
}

/** 20 URL-safe random characters, the length of the plugin's own identifiers. */
function randomToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(15))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}
