/** Keep signed-in account state compact enough for the shared application navbar. */
export const NAV_EMAIL_MAX_CHARACTERS = 28

/**
 * The published user docs. One site for every deployment, managed or standalone, which is why
 * it is a constant rather than deployment configuration like the origins below.
 */
export const PUBLIC_DOCS_URL = 'https://docs.etherpk.com'

/**
 * Where the Client's source will be published. Linked from the landing page ahead of the
 * repository going public, so the link is dead until then and the page says so beside it.
 */
export const CLIENT_REPOSITORY_URL = 'https://github.com/appsoftwareltd/etherpk-client'

export interface ApplicationNavigationItem {
    href: string
    label: 'Account' | 'Sync Server' | 'Graphs' | 'Docs'
    current: boolean
}

export interface ApplicationNavigationOptions {
    accountUrl?: string | null
    syncServerUrl?: string | null
    graphsUrl: string
    /** Offered by Corporate, the public face; the working applications keep the tier short. */
    docsUrl?: string | null
    current?: 'account' | 'sync-server' | 'graphs' | null
}

/**
 * Keep the cross-application destinations in one deliberate order. This tier is only ever
 * cross-application: an application's own signed-in home belongs in its section navigation,
 * not here, so a Dashboard never appears among these. Managed deployments add the Corporate
 * Account destination; standalone deployments retain only Sync Server and Graphs.
 */
export function buildApplicationNavigation(
    options: ApplicationNavigationOptions,
): ApplicationNavigationItem[] {
    const items: ApplicationNavigationItem[] = []

    if (options.accountUrl) {
        items.push({
            href: options.accountUrl,
            label: 'Account',
            current: options.current === 'account',
        })
    }
    if (options.syncServerUrl) {
        items.push({
            href: options.syncServerUrl,
            label: 'Sync Server',
            current: options.current === 'sync-server',
        })
    }
    items.push({
        href: options.graphsUrl,
        label: 'Graphs',
        current: options.current === 'graphs',
    })
    // Last: it leaves the deployment, and it is never the current page.
    if (options.docsUrl) {
        items.push({ href: options.docsUrl, label: 'Docs', current: false })
    }

    return items
}

/**
 * Truncate by JavaScript characters, including the three trailing dots in the fixed limit.
 * The full email remains available to navigation components through their accessible label/title.
 */
export function truncateNavigationEmail(
    email: string,
    maxCharacters = NAV_EMAIL_MAX_CHARACTERS,
): string {
    if (email.length <= maxCharacters) return email
    if (maxCharacters <= 3) return '.'.repeat(Math.max(0, maxCharacters))
    return `${email.slice(0, maxCharacters - 3)}...`
}

/**
 * Navigation targets are deployment configuration, not arbitrary redirect URLs. Restrict them to
 * an HTTPS origin, while retaining ordinary loopback HTTP support for local development.
 */
export function parseNavigationOrigin(value: string, name: string): string {
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        throw new Error(`${name} must be an absolute HTTP or HTTPS URL`)
    }

    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
        throw new Error(`${name} must use HTTPS except on localhost`)
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${name} must be an origin without a path, query, or fragment`)
    }
    return url.origin
}

export function buildClientGraphsUrl(clientOrigin: string): string {
    return new URL('/graphs', `${parseNavigationOrigin(clientOrigin, 'CLIENT_PUBLIC_URL')}/`).href
}

/** The Client's Demo Graph entry (ADR 0069), linked from the marketing home. */
export function buildClientDemoUrl(clientOrigin: string): string {
    return new URL('/demo', `${parseNavigationOrigin(clientOrigin, 'CLIENT_PUBLIC_URL')}/`).href
}

export function buildAccountUrl(corporateOrigin: string): string {
    return new URL('/account', `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}

/** Corporate's billing page: where a Free account starts its Sync+ Trial (ADR 0068). */
export function buildBillingUrl(corporateOrigin: string): string {
    return new URL('/billing', `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}

/** Corporate's public pricing page, linked from the Client's own landing page. */
export function buildPricingUrl(corporateOrigin: string): string {
    return new URL('/pricing', `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}

/**
 * Corporate's public home. The Client serves the same landing page on its own origin, so a
 * managed Client names this as the page's canonical URL and search engines index one copy;
 * a standalone Client has no Corporate and names none.
 */
export function buildHomeUrl(corporateOrigin: string): string {
    return new URL('/home', `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}

export function buildSyncServerUrl(serverOrigin: string): string {
    return new URL('/', `${parseNavigationOrigin(serverOrigin, 'Sync Server origin')}/`).href
}

function isLoopback(hostname: string): boolean {
    return hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname === '127.0.0.1'
        || hostname === '[::1]'
}
