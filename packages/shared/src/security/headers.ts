/**
 * Response security headers, shared by all three apps.
 *
 * Sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`
 * and, over HTTPS, `Strict-Transport-Security`. The CSP itself is configured through `kit.csp` in each app's `svelte.config.ts`, because
 * SvelteKit has to nonce the scripts it emits and an ingress cannot do that. Everything that
 * does not need per-response state is set here.
 */

export interface SecurityHeaderOptions {
    /**
     * Whether the request arrived over HTTPS. HSTS is only sent then: setting it over plain
     * HTTP is ignored by browsers anyway, and sending it in local development would pin
     * `localhost` to HTTPS in the developer's browser for the max-age, which is unpleasant
     * to undo.
     */
    https: boolean
}

/** One year, the minimum for preload eligibility. */
const HSTS_MAX_AGE_SECONDS = 31_536_000

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
    const headers: Record<string, string> = {
        // Stop the browser guessing a type for a response we said was something else. The
        // asset routes serve user ciphertext, so a sniffed text/html would be a real problem.
        'X-Content-Type-Options': 'nosniff',
        // The CSP's frame-ancestors supersedes this everywhere current, but X-Frame-Options
        // is still what older browsers and some scanners read.
        'X-Frame-Options': 'DENY',
        // Send the full URL same-origin, the origin only when crossing to another HTTPS site,
        // nothing when downgrading. Keeps invite and verification URLs out of Referer headers.
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        // Nothing in EtherPK uses these, so decline them rather than inherit a default.
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    }

    if (options.https) {
        headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`
    }

    return headers
}

/** Apply {@link securityHeaders} to a response in place. */
export function applySecurityHeaders(response: Response, options: SecurityHeaderOptions): void {
    for (const [name, value] of Object.entries(securityHeaders(options))) {
        response.headers.set(name, value)
    }
}
