/**
 * Request-log redaction, shared by every EtherPK server's `handle` and `handleError` hooks.
 *
 * Each app logs the path and query string of every request at info level and ships them to
 * OpenObserve. Corporate is the OIDC and OAuth authority, so that stream would otherwise carry
 * single-use credentials in plaintext, in two shapes:
 *
 * - in the query: `/api/auth/verify-email?token=...` (which, with `autoSignInAfterVerification`,
 *   mints a session) and `/api/auth/callback/google?code=...&state=...`;
 * - in the path: better-auth 1.6.15 mails `${baseURL}/reset-password/${token}`, whose GET
 *   redirects to the reset page without consuming the token. A logged path is a password reset
 *   for anyone who reads the log, for the hour the token lives.
 *
 * Anyone with read access to the log store could replay them. The same goes for personal data
 * the log has no use for: an invitee's email address, or the name of a document in a Client
 * address. Redact at the call site rather than in the logger, so a caller that genuinely needs
 * a raw value can still ask for one.
 */

const REDACTED = '[redacted]'

/**
 * Parameter names redacted outright. OAuth and better-auth credential carriers, plus the
 * PKCE and CSRF values that make a stolen `code` usable.
 */
const SENSITIVE_QUERY_PARAMETERS = new Set([
    'access_token',
    'client_secret',
    'code',
    'code_challenge',
    'code_verifier',
    'id_token',
    'jwt',
    'nonce',
    'otp',
    'refresh_token',
    'signature',
    'state',
    'token',
])

/**
 * Substrings that make a parameter sensitive whatever it is called. Catches the names a
 * future library introduces (`csrf_token`, `app_secret`, `new_password`) without needing
 * the denylist above to be exhaustive. `email` is personal data rather than a credential, but
 * the log has no more use for it: `/login?email=` is the verification landing page, and an
 * address someone typed need not belong to anybody with an account (`inviteeEmail`).
 */
const SENSITIVE_QUERY_PARAMETER_FRAGMENTS = ['token', 'secret', 'password', 'passphrase', 'email']

function isSensitiveParameterName(rawName: string): boolean {
    // Percent-encoded names are rare but trivially defeat an exact match, so decode first.
    let name = rawName
    try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '))
    } catch {
        // Malformed encoding — fall back to the raw name rather than dropping the check.
    }
    name = name.trim().toLowerCase()
    if (SENSITIVE_QUERY_PARAMETERS.has(name)) return true
    return SENSITIVE_QUERY_PARAMETER_FRAGMENTS.some((fragment) => name.includes(fragment))
}

/**
 * Replace the values of sensitive parameters in a `?a=1&b=2` query string, leaving every
 * other pair byte-for-byte intact so the log line stays useful for diagnostics.
 *
 * Splitting by hand rather than round-tripping through `URLSearchParams` deliberately:
 * the latter re-encodes and reorders, which makes log lines harder to compare against a
 * real request.
 */
export function redactQueryString(search: string | null | undefined): string | undefined {
    if (!search) return undefined
    const query = search.startsWith('?') ? search.slice(1) : search
    if (!query) return undefined

    const redacted = query
        .split('&')
        .map((pair) => {
            const separator = pair.indexOf('=')
            // A valueless parameter carries nothing to leak; leave it as-is so the log
            // still shows it was present.
            if (separator === -1) return pair
            const name = pair.slice(0, separator)
            if (isSensitiveParameterName(name)) return `${name}=${REDACTED}`
            // A return path (`redirect`, `callbackURL`) can name a Client document. Judge the
            // decoded value as a path; only a value the path rules cut is rewritten.
            const value = decodeQueryValue(pair.slice(separator + 1))
            if (value?.startsWith('/')) {
                const redactedPath = redactPath(value)
                if (redactedPath !== value) return `${name}=${redactedPath}`
            }
            return pair
        })
        .join('&')

    return `?${redacted}`
}

function decodeQueryValue(raw: string): string | null {
    try {
        return decodeURIComponent(raw.replace(/\+/g, ' '))
    } catch {
        return null // malformed encoding: leave the pair as it came
    }
}

/**
 * Redact the query string inside a URL-shaped value, preserving path and fragment. Used for
 * the `Location` header on 3xx responses, which on an OAuth authorization redirect carries
 * the same `code` and `state` the query-string redaction above exists to remove.
 *
 * Accepts absolute and relative URLs, and passes `null` / `undefined` through so a caller
 * can hand it `headers.get('location')` directly.
 */
export function redactUrlQuery<T extends string | null | undefined>(url: T): T {
    if (!url) return url
    const queryStart = url.indexOf('?')
    if (queryStart === -1) return url

    const fragmentStart = url.indexOf('#', queryStart)
    const search = fragmentStart === -1 ? url.slice(queryStart) : url.slice(queryStart, fragmentStart)
    const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart)

    return `${url.slice(0, queryStart)}${redactQueryString(search) ?? ''}${fragment}` as T
}

/**
 * Paths whose tail is a credential or the user's content. Each pattern captures the part of the
 * path that is kept; everything after it is replaced whole, so a trailing segment cannot carry
 * the value past the rule. Matched case-insensitively, since a router that folds case would
 * still serve the request.
 *
 * - Better Auth's password-reset link, `/api/auth/reset-password/:token`. It is the only
 *   better-auth 1.6.15 route with a credential in the path (`/callback/:id`,
 *   `/oauth2/callback/:providerId` and `/oauth2/client/:id` carry identifiers, not secrets).
 * - A Client document address, `/g/<graphId>/d/<document name>`. The name is the user's
 *   content, and on an encrypted graph the server otherwise never learns it.
 */
const SENSITIVE_PATH_PREFIXES: RegExp[] = [
    /^(\/api\/auth\/reset-password\/)./i,
    /^(\/g\/[^/]+\/d\/)./i,
]

/**
 * Replace the credential or content tail of a request path with `[redacted]`, leaving every
 * other path unchanged. Pair it with {@link redactQueryString}: this covers the path, that the
 * query.
 */
export function redactPath<T extends string | null | undefined>(pathname: T): T {
    if (!pathname) return pathname
    for (const pattern of SENSITIVE_PATH_PREFIXES) {
        const match = pattern.exec(pathname)
        if (match) return `${match[1]}${REDACTED}` as T
    }
    return pathname
}

/**
 * {@link redactPath} and {@link redactUrlQuery} together, for a URL-shaped value such as a
 * `Location` header: a Client redirect back to `returnPath` can name a document, and an OAuth
 * redirect carries a `code`. Absolute URLs keep their origin; only the path after it is judged.
 */
export function redactUrl<T extends string | null | undefined>(url: T): T {
    if (!url) return url
    const withQuery = redactUrlQuery(url) as string
    const tailStart = withQuery.search(/[?#]/)
    const base = tailStart === -1 ? withQuery : withQuery.slice(0, tailStart)
    const tail = tailStart === -1 ? '' : withQuery.slice(tailStart)
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(base)?.[0] ?? ''
    return `${origin}${redactPath(base.slice(origin.length))}${tail}` as T
}

/**
 * Whether an error response body may be captured into the log line.
 *
 * API error bodies are valuable diagnostics, but better-auth's are not: they carry account
 * detail and, on some routes, echo submitted credentials. Exclude `/api/auth/**` entirely
 * rather than trying to redact a body whose shape is the library's to change.
 */
export function shouldCaptureErrorResponseBody(pathname: string): boolean {
    return pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')
}
