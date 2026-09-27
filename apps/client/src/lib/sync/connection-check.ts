/**
 * Why a server address and Personal Access Token could not be saved, said at the field to fix.
 *
 * Sync settings look the account up (`/api/v1/sync/me`) before saving a connection, so a
 * mistyped, revoked or graph-limited token, or the app's own address pasted as the server's, is
 * caught while the form is still open. The server refuses a token it does not accept, and a token
 * limited to some graphs, with the same 401.
 */
import { SyncApiError } from './sync-api'
import { describeSyncFailure } from './sync-error-copy'

export interface ConnectionCheckFailure {
    field: 'url' | 'token'
    message: string
    /** Where to make a new token, for a token the server refused. */
    tokensUrl?: string
}

const NOT_A_SYNC_SERVER = "That address is not an EtherPK Sync Server. Use the server's address, not the app's."

export function describeConnectionCheckFailure(err: unknown, serverBaseUrl: string): ConnectionCheckFailure {
    const server = serverBaseUrl.trim().replace(/\/+$/, '')
    if (err instanceof SyncApiError) {
        if (err.status === 401) {
            return {
                field: 'token',
                message: 'This server did not accept the token. It may be mistyped, expired, revoked or limited to some graphs. Create one for your whole account on the server\'s Access tokens page.',
                tokensUrl: `${server}/account/tokens`,
            }
        }
        if (err.status === 404) return { field: 'url', message: NOT_A_SYNC_SERVER }
        return { field: 'url', message: describeSyncFailure(err, 'check the connection') }
    }
    // A page that answered but is not the account lookup's JSON.
    if (err instanceof SyntaxError) return { field: 'url', message: NOT_A_SYNC_SERVER }
    // No answer at all: a wrong host, no connection, or a server that refuses this app's origin,
    // which the browser reports exactly like a failed connection.
    return {
        field: 'url',
        message: `Could not reach ${server}. Check the address and your connection. If both are right, ask the server's administrator whether it accepts connections from this app.`,
    }
}
