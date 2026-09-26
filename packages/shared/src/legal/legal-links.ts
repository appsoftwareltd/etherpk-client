import { error, redirect } from '@sveltejs/kit'
import { parseNavigationOrigin } from '../deployment-navigation'

/**
 * Where a deployment's Terms, Privacy Policy and Contact page are.
 *
 * On a managed deployment they are EtherPK's own and Corporate serves them: Corporate renders the
 * one copy, and the Client and the Sync Server link to it and send their own `/terms` and
 * `/privacy` there. A self-hosted deployment belongs to its operator, whose pages are at the URLs
 * the operator configures (`TERMS_URL` and `PRIVACY_URL` on the Sync Server, `PUBLIC_TERMS_URL`
 * and `PUBLIC_PRIVACY_URL` on the Client), or do not exist. A self-hosted install never serves
 * EtherPK's terms as if they governed it.
 *
 * A null entry means the deployment has no such page: footers leave the link out and the route
 * answers 404.
 */
export interface LegalLinks {
    termsUrl: string | null
    privacyUrl: string | null
    contactUrl: string | null
}

export function managedLegalLinks(corporateOrigin: string): LegalLinks {
    const origin = `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`
    return {
        termsUrl: new URL('/terms', origin).href,
        privacyUrl: new URL('/privacy', origin).href,
        contactUrl: new URL('/contact', origin).href,
    }
}

/**
 * An operator's legal page, as configured: null when unset. Any path is allowed, since the page
 * usually lives on the operator's own site, but it must be an absolute HTTPS URL (plain HTTP on
 * loopback only), because it is rendered as a link and used as a redirect target.
 */
export function parseLegalPageUrl(value: string | undefined, name: string): string | null {
    const trimmed = value?.trim()
    if (!trimmed) return null

    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        throw new Error(`${name} must be an absolute HTTPS URL, or unset`)
    }
    const loopback = url.hostname === 'localhost'
        || url.hostname.endsWith('.localhost')
        || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error(`${name} must use HTTPS except on localhost`)
    }
    if (url.username || url.password) {
        throw new Error(`${name} must not contain credentials`)
    }
    return url.href
}

/**
 * The response for `/terms` or `/privacy` on the Client and the Sync Server: a temporary redirect
 * to the page, which a changed setting can move, or 404 where the deployment has none.
 */
export function serveLegalPage(url: string | null): never {
    if (url) redirect(307, url)
    error(404, 'Not found')
}
