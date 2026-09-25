export type Environment = Record<string, string | undefined>

export interface ManagedClientAuthConfig {
    clientPublicUrl: string
    callbackUrl: string
    issuer: string
    clientId: string
    managedSyncUrl: string
    postLogoutUrl: string
    sessionSecret: string
    scopes: ['openid', 'profile', 'email', 'offline_access', 'sync']
}

const managedOAuthVariables = [
    'CORPORATE_ISSUER',
    'MANAGED_OAUTH_CLIENT_ID',
    'MANAGED_SYNC_URL',
    'CLIENT_SESSION_SECRET',
] as const

/**
 * Return no managed OAuth configuration when the whole preset is disabled.
 * A partial preset is rejected so a deployment cannot show a sign-in journey
 * whose issuer, client registration, Sync API or cookie encryption is missing.
 */
export function parseOptionalManagedClientAuthConfig(environment: Environment): ManagedClientAuthConfig | null {
    const configuredVariables = managedOAuthVariables.filter((name) => environment[name]?.trim())
    if (configuredVariables.length === 0) return null
    if (configuredVariables.length !== managedOAuthVariables.length) {
        throw new Error('Managed Client OAuth configuration must be either complete or disabled')
    }
    return parseManagedClientAuthConfig(environment)
}

export function parseManagedClientAuthConfig(environment: Environment): ManagedClientAuthConfig {
    const clientPublicUrl = parseOrigin(required(environment, 'CLIENT_PUBLIC_URL'), 'CLIENT_PUBLIC_URL')
    const issuer = parseOrigin(required(environment, 'CORPORATE_ISSUER'), 'CORPORATE_ISSUER')
    const managedSyncUrl = parseOrigin(required(environment, 'MANAGED_SYNC_URL'), 'MANAGED_SYNC_URL')
    const sessionSecret = required(environment, 'CLIENT_SESSION_SECRET')
    if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
        throw new Error('CLIENT_SESSION_SECRET must contain at least 32 bytes')
    }

    return {
        clientPublicUrl,
        callbackUrl: `${clientPublicUrl}/auth/callback`,
        issuer,
        clientId: required(environment, 'MANAGED_OAUTH_CLIENT_ID'),
        managedSyncUrl,
        // Corporate may only redirect to an exact registered URI after ending its session.
        // This fixed Server hop clears the independently scoped Server portal cookie.
        postLogoutUrl: `${managedSyncUrl}/auth/portal/logout/managed?finish=client`,
        sessionSecret,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'sync'],
    }
}

function required(environment: Environment, name: string): string {
    const value = environment[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
}

function parseOrigin(value: string, name: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`${name} must be an absolute URL`)
    }
    // RFC 6761 reserves localhost and its subdomains for loopback use. Subdomains let the local
    // apps use independent host-only cookies while all ordinary HTTP origins remain rejected.
    const loopback = url.hostname === 'localhost'
        || url.hostname.endsWith('.localhost')
        || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error(`${name} must use HTTPS except on localhost`)
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`${name} must be an origin`)
    }
    return url.origin
}
