import { describe, expect, it, vi } from 'vitest'
import { listSignedInSessions, signOutSignedInSession, type SignedInSessionStore } from './signed-in-sessions'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

interface StoredSession {
    id: string
    token: string
    userId: string
    userAgent: string | null
    ipAddress: string | null
    createdAt: Date
    expiresAt: Date
}

function session(fields: Partial<StoredSession> & Pick<StoredSession, 'id'>): StoredSession {
    return {
        token: `token-of-${fields.id}`,
        userId: 'user-1',
        userAgent: 'Mozilla/5.0',
        ipAddress: '192.0.2.1',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + DAY),
        ...fields,
    }
}

/** Better Auth's session table as its internal adapter reads it, without secondary storage. */
function store(rows: StoredSession[]) {
    return {
        internalAdapter: {
            listSessions: async (userId: string, options?: { onlyActiveSessions?: boolean }) =>
                rows.filter((row) => row.userId === userId && (!options?.onlyActiveSessions || row.expiresAt > new Date())),
        },
    } satisfies SignedInSessionStore
}

describe('listSignedInSessions', () => {
    it("lists the user's sessions, this browser's first and then the newest, without their tokens", async () => {
        const sessions = store([
            session({ id: 'phone', createdAt: new Date(now - 40 * DAY), userAgent: 'Android' }),
            session({ id: 'laptop', createdAt: new Date(now - 2 * DAY) }),
            session({ id: 'tablet', createdAt: new Date(now - 10 * DAY) }),
            session({ id: 'someone-else', userId: 'user-2' }),
        ])

        const listed = await listSignedInSessions(sessions, 'user-1', 'phone')

        expect(listed).toEqual([
            { id: 'phone', userAgent: 'Android', ipAddress: '192.0.2.1', createdAt: new Date(now - 40 * DAY), current: true },
            { id: 'laptop', userAgent: 'Mozilla/5.0', ipAddress: '192.0.2.1', createdAt: new Date(now - 2 * DAY), current: false },
            { id: 'tablet', userAgent: 'Mozilla/5.0', ipAddress: '192.0.2.1', createdAt: new Date(now - 10 * DAY), current: false },
        ])
    })

    it('leaves out a session that has expired', async () => {
        const sessions = store([session({ id: 'laptop' }), session({ id: 'old-phone', expiresAt: new Date(now - DAY) })])

        const listed = await listSignedInSessions(sessions, 'user-1', 'laptop')

        expect(listed.map((row) => row.id)).toEqual(['laptop'])
    })
})

describe('signOutSignedInSession', () => {
    const rows = [
        session({ id: 'laptop' }),
        session({ id: 'phone' }),
        session({ id: 'expired', expiresAt: new Date(now - DAY) }),
        session({ id: 'someone-else', userId: 'user-2' }),
    ]

    it("signs out the user's session with that id, by its token", async () => {
        const revoke = vi.fn(async () => {})

        await signOutSignedInSession(store(rows), { userId: 'user-1', sessionId: 'phone', revoke })

        expect(revoke).toHaveBeenCalledExactlyOnceWith('token-of-phone')
    })

    it.each(['someone-else', 'expired', 'unknown'])('signs nothing out for %s, which is not one of the user\'s sessions', async (sessionId) => {
        const revoke = vi.fn(async () => {})

        await signOutSignedInSession(store(rows), { userId: 'user-1', sessionId, revoke })

        expect(revoke).not.toHaveBeenCalled()
    })
})
