/**
 * Request-log redaction, shared by the Sync Server and Corporate `handle` hooks.
 *
 * Both apps log the full query string of every request at info level and ship it to
 * OpenObserve. Corporate is the OIDC and OAuth authority, so that stream would otherwise
 * carry single-use credentials in plaintext: `/api/auth/verify-email?token=...` (which,
 * with `autoSignInAfterVerification`, mints a session), `/api/auth/reset-password?token=...`,
 * and `/api/auth/callback/google?code=...&state=...`. Anyone with read access to the log
 * store could replay them. Redact at the call site rather than in the logger, so a caller
 * that genuinely needs a raw value can still ask for one.
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
 * the denylist above to be exhaustive.
 */
const SENSITIVE_QUERY_PARAMETER_FRAGMENTS = ['token', 'secret', 'password', 'passphrase']

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
            return isSensitiveParameterName(name) ? `${name}=${REDACTED}` : pair
        })
        .join('&')

    return `?${redacted}`
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
 * Whether an error response body may be captured into the log line.
 *
 * API error bodies are valuable diagnostics, but better-auth's are not: they carry account
 * detail and, on some routes, echo submitted credentials. Exclude `/api/auth/**` entirely
 * rather than trying to redact a body whose shape is the library's to change.
 */
export function shouldCaptureErrorResponseBody(pathname: string): boolean {
    return pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')
}
