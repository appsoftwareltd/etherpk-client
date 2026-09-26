/**
 * The one check every EtherPK app applies to a return path that came from a request: a
 * `?redirect=` on a sign-in or registration page, a verification email's `callbackURL`, the page
 * an OAuth transaction returns to.
 *
 * The answer is a path on the current origin, or `fallback`. Prefix checks are not enough,
 * because the WHATWG URL parser a browser uses rewrites what it is given before resolving it:
 *
 * - it strips tab, CR and LF anywhere, so `/<TAB>/evil.example` becomes `//evil.example`;
 * - it reads `\` as `/` in http(s) URLs, so `/\evil.example` is protocol-relative;
 * - it collapses dot segments, so `/..//evil.example` has the path `//evil.example`, which a
 *   browser given that path on its own resolves to another host.
 *
 * So the value is parsed against a placeholder origin and kept only when it stays there, and the
 * path it produces is checked again. Control characters and backslashes are refused outright,
 * raw or percent-encoded once, as no return path an EtherPK page builds contains either, and an
 * encoded one would be decoded by any later hop that reads the value as a query parameter.
 */
export function safeReturnPath(value: string | null | undefined, fallback: string): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback

    let decoded: string
    try {
        decoded = decodeURIComponent(value)
    } catch {
        return fallback
    }
    if (UNSAFE_CHARACTER.test(value) || UNSAFE_CHARACTER.test(decoded) || decoded.startsWith('//')) {
        return fallback
    }

    const url = new URL(value, PLACEHOLDER_ORIGIN)
    if (url.origin !== PLACEHOLDER_ORIGIN) return fallback
    // A dot segment can collapse the path to one that starts with `//` while the origin holds.
    if (url.pathname.startsWith('//')) return fallback
    return url.pathname + url.search + url.hash
}

/** `.invalid` is reserved (RFC 2606), so no real request can resolve to it. */
const PLACEHOLDER_ORIGIN = 'http://relative.invalid'

/** C0 controls, DEL and the backslash. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f\\]/
