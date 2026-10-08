import { SyncApiError } from '$lib/sync/sync-api'

/** Socket and TLS error codes Node's fetch reports as the cause of "fetch failed". */
const TLS_CODES = new Set([
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'EPROTO',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * Why connecting to a Sync Server failed, in terms a person can act on, or null for a failure
 * this does not recognise. The first mistakes a login makes - the EtherPK app's address in place
 * of the server's, a wrong or revoked token, https against a plain-HTTP server, a mistyped host -
 * otherwise read as "HTTP 404", "Unauthorized" or "fetch failed".
 */
export function describeConnectionFailure(error: unknown, syncServer: string): string | null {
    if (error instanceof SyncApiError) {
        // A 404 with no JSON body: the address answers, but not as a Sync Server does.
        if (error.status === 404 && error.message === 'HTTP 404') {
            return `${syncServer} is not a Sync Server (it may be the EtherPK app). Use the Sync Server address shown in EtherPK under a synced graph's Settings > Agents.`
        }
        if (error.status === 401) {
            // An agent token also stops working after 30 days unused (ADR 0132).
            return `${syncServer} did not accept the token: it may have been revoked, mistyped, or left unused for 30 days. Make a setup code in EtherPK (a synced graph's Settings > Agents) and run login again.`
        }
        return null
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
        const code = (error.cause as { code?: unknown } | undefined)?.code
        const reason = code === 'ENOTFOUND' ? 'the host was not found. Check the address.'
            : code === 'ECONNREFUSED' ? 'the connection was refused. Check the address and that the server is running.'
                : typeof code === 'string' && TLS_CODES.has(code) ? 'the secure connection failed. Check whether the server uses https or http.'
                    : `it did not answer (${typeof code === 'string' ? code : 'no reason given'}).`
        return `Could not connect to ${syncServer}: ${reason}`
    }
    return null
}
