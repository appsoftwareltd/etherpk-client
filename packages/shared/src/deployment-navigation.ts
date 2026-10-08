/** Keep signed-in account state compact enough for the shared application navbar. */
export const NAV_EMAIL_MAX_CHARACTERS = 28

/**
 * The published user docs. One site for every deployment, managed or standalone, which is why
 * it is a constant rather than deployment configuration like the origins below.
 */
export const PUBLIC_DOCS_URL = 'https://docs.etherpk.com'

/** The EtherPK blog, linked beneath the docs on the landing page. One site for every deployment. */
export const PUBLIC_BLOG_URL = 'https://blog.etherpk.com'

/**
 * Where the Client's source is published: its source-available Public Repository (ADR 0096).
 */
export const CLIENT_REPOSITORY_URL = 'https://github.com/appsoftwareltd/etherpk-client'

/**
 * EtherPK's community server on Discord, linked beneath the Client's repository on the landing
 * page. The invite never expires. The user docs and every README carry the same link, the npm
 * package's included, so a new invite means changing each of them.
 */
export const COMMUNITY_DISCORD_URL = 'https://discord.gg/m9vScxQzvp'

export interface ApplicationNavigationItem {
    href: string
    label: 'Sync+' | 'Sync Server' | 'Graphs' | 'Docs'
    current: boolean
}

export interface ApplicationNavigationOptions {
    /**
     * A managed deployment (Corporate in front) names its Sync Server link after the service's
     * plan, Sync+, and a standalone one keeps Sync Server: a bare "Sync" would read as the Graphs
     * page's own Sync tab.
     */
    managed: boolean
    /**
     * Whether someone is signed in. Signed out on the managed service, the Sync+ link opens the
     * pricing page instead of the Sync Server, because there is no Sync+ account to open yet.
     */
    signedIn: boolean
    syncServerUrl?: string | null
    /** Corporate's pricing page, on the managed service. */
    pricingUrl?: string | null
    graphsUrl: string
    /** `sync-server` marks the Sync+ link, whichever page it leads to. */
    current?: 'sync-server' | 'graphs' | null
}

/**
 * Keep the cross-application destinations in one deliberate order on every origin: the Sync
 * Server, Graphs, then the public docs. This tier is only ever cross-application. An
 * application's own signed-in home belongs in its section navigation, and the person's Account,
 * Billing and administration pages belong in the account menu (`buildAccountMenu`), so neither
 * appears here and the two never repeat each other.
 */
export function buildApplicationNavigation(
    options: ApplicationNavigationOptions,
): ApplicationNavigationItem[] {
    const items: ApplicationNavigationItem[] = []

    if (options.syncServerUrl) {
        // A standalone Server sells nothing, so its link always opens the Server.
        const pricingUrl = options.managed && !options.signedIn ? options.pricingUrl : null
        items.push({
            href: pricingUrl || options.syncServerUrl,
            label: options.managed ? 'Sync+' : 'Sync Server',
            current: options.current === 'sync-server',
        })
    }
    items.push({
        href: options.graphsUrl,
        label: 'Graphs',
        current: options.current === 'graphs',
    })
    // Last: it leaves the deployment, and it is never the current page. One site for every
    // deployment, so it is not an option.
    items.push({ href: PUBLIC_DOCS_URL, label: 'Docs', current: false })

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

/** Corporate's user administration: the managed service's Users page (the EtherPK accounts). */
export function buildAdminUsersUrl(corporateOrigin: string): string {
    return new URL('/admin/users', `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}

/** The Sync Server's storage administration, which Corporate's account menu lists too. */
export function buildSyncStorageAdminUrl(serverOrigin: string): string {
    return new URL('/admin/storage', `${parseNavigationOrigin(serverOrigin, 'Sync Server origin')}/`).href
}

/** The Sync Server's Access tokens page, which every app's account menu links to. */
export function buildSyncAccessTokensUrl(serverOrigin: string): string {
    return new URL('/account/tokens', `${parseNavigationOrigin(serverOrigin, 'Sync Server origin')}/`).href
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
