/**
 * The Account page's Sessions list, read and signed out without Better Auth's `/list-sessions`.
 *
 * That endpoint answers only a session signed in within `session.freshAge` (a day by default),
 * and a device can stay signed in far longer: rolling refresh moves a session's expiry, never its
 * `createdAt`. It also returns every session's token. The page needs neither the check nor the
 * tokens: the list is read through Better Auth's internal adapter, the browser gets session ids,
 * and a sign-out looks the token up on the server.
 */

/** One row of Better Auth's session table, as far as the list reads it. */
interface StoredSession {
    id: string
    token: string
    userAgent?: string | null
    ipAddress?: string | null
    createdAt: Date
    expiresAt: Date
}

/**
 * The part of Better Auth's context (`await auth.$context`) the list needs. Named structurally so
 * both apps pass their own instance without a shared auth type.
 */
export interface SignedInSessionStore {
    internalAdapter: {
        listSessions(userId: string, options?: { onlyActiveSessions?: boolean }): Promise<StoredSession[]>
    }
}

/** Where the account is signed in, as the browser sees it: no token. */
export interface SignedInSession {
    id: string
    userAgent: string | null
    ipAddress: string | null
    createdAt: Date
    /** The session this request came from. */
    current: boolean
}

/**
 * The user's signed-in sessions, the current one first and then the newest. The same rows
 * `/list-sessions` returns, without its freshness check or the tokens.
 */
export async function listSignedInSessions(
    store: SignedInSessionStore,
    userId: string,
    currentSessionId: string | undefined,
): Promise<SignedInSession[]> {
    const sessions = await store.internalAdapter.listSessions(userId, { onlyActiveSessions: true })
    return sessions
        .map((session) => ({
            id: session.id,
            userAgent: session.userAgent ?? null,
            ipAddress: session.ipAddress ?? null,
            createdAt: session.createdAt,
            current: session.id === currentSessionId,
        }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.getTime() - a.createdAt.getTime())
}

/**
 * Sign out one of the user's sessions, named by the id the list gave the browser. `revoke` ends it
 * by token: each app passes Better Auth's `/revoke-session` with the request's headers, so the
 * app's own after hooks for a sign-out run as they do for a browser's call. An id that is not one
 * of the user's signed-in sessions (another user's, one already ended, or none) signs nothing out.
 */
export async function signOutSignedInSession(
    store: SignedInSessionStore,
    target: { userId: string; sessionId: string; revoke: (token: string) => Promise<unknown> },
): Promise<void> {
    const sessions = await store.internalAdapter.listSessions(target.userId, { onlyActiveSessions: true })
    const session = sessions.find((candidate) => candidate.id === target.sessionId)
    if (session) await target.revoke(session.token)
}
