import { describe, expect, it } from 'vitest'

import type { SyncActivity } from '#lib/sync/graph-sync.js'

import { connectionChangeLine, followConnection, offlineNotice, offlineSince, type ConnectionChange } from './graph-connection'

const STARTED = Date.parse('2026-03-01T10:00:00.000Z')
const MINUTE = 60_000

/** A sync session a test moves by hand, with a clock it moves by hand. */
function session(connection: SyncActivity['connection']) {
    const activity: SyncActivity = { connection, unsentDocuments: 0, refusal: null, waitingForKey: null }
    const listeners = new Set<(activity: SyncActivity) => void>()
    let time = STARTED
    const changes: ConnectionChange[] = []
    return {
        changes,
        now: () => time,
        source: {
            activity: () => ({ ...activity }),
            onActivity(listener: (activity: SyncActivity) => void) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        },
        wait(ms: number) {
            time += ms
        },
        /** The state changes as the socket does; listeners hear later, as `onActivity` coalesces. */
        set(change: Partial<SyncActivity>) {
            Object.assign(activity, change)
        },
        announce() {
            for (const listener of listeners) listener({ ...activity })
        },
    }
}

function followed(s: ReturnType<typeof session>) {
    return followConnection(s.source, { now: s.now, onChange: (change) => s.changes.push(change) })
}

describe('followConnection', () => {
    it('is connected from the moment it starts over an open socket', () => {
        const s = session('open')
        expect(followed(s).current()).toEqual({ state: 'connected', since: new Date(STARTED).toISOString() })
    })

    it('is offline while the first socket has not opened', () => {
        const s = session('connecting')
        expect(followed(s).current()).toEqual({ state: 'offline', since: new Date(STARTED).toISOString(), unsentDocuments: 0 })
    })

    it('reports a drop as soon as it is asked, without waiting for the coalesced announcement', () => {
        const s = session('open')
        const connection = followed(s)
        s.wait(5 * MINUTE)
        s.set({ connection: 'reconnecting', unsentDocuments: 2 })
        const dropped = new Date(STARTED + 5 * MINUTE).toISOString()
        expect(connection.current()).toEqual({ state: 'offline', since: dropped, unsentDocuments: 2 })

        // The moment it was first seen stands: a later announcement does not move it.
        s.wait(MINUTE)
        s.announce()
        expect(connection.current()).toEqual({ state: 'offline', since: dropped, unsentDocuments: 2 })
        expect(s.changes).toHaveLength(1)
    })

    it('hears a drop from the announcement when no one asks, and how long it lasted when the socket returns', () => {
        const s = session('open')
        const connection = followed(s)
        s.set({ connection: 'reconnecting' })
        s.announce()
        expect(s.changes.map((change) => change.connection.state)).toEqual(['offline'])
        expect(s.changes[0].offlineForMs).toBeNull()

        s.wait(25 * MINUTE)
        s.set({ connection: 'open' })
        s.announce()
        expect(connection.current()).toEqual({ state: 'connected', since: new Date(STARTED + 25 * MINUTE).toISOString() })
        expect(s.changes[1]).toEqual({ connection: connection.current(), offlineForMs: 25 * MINUTE })
    })

    it('does not count the first connection as a return', () => {
        const s = session('connecting')
        followed(s)
        s.wait(300)
        s.set({ connection: 'open' })
        s.announce()
        expect(s.changes).toHaveLength(1)
        expect(s.changes[0].offlineForMs).toBeNull()
    })

    it('keeps the time when an announcement changes something other than the connection', () => {
        const s = session('reconnecting')
        const connection = followed(s)
        s.wait(MINUTE)
        s.set({ unsentDocuments: 3 })
        s.announce()
        expect(connection.current()).toEqual({ state: 'offline', since: new Date(STARTED).toISOString(), unsentDocuments: 3 })
        expect(s.changes).toEqual([])
    })

    it('stays offline once the session has ended', () => {
        const s = session('open')
        const connection = followed(s)
        s.set({ connection: 'ended' })
        expect(connection.current().state).toBe('offline')
    })
})

describe('what is said about an offline copy', () => {
    const since = new Date(STARTED).toISOString()

    it.each([
        [20_000, 'under a minute'],
        [MINUTE, '1 minute'],
        [25 * MINUTE, '25 minutes'],
        [60 * MINUTE, '1 hour'],
        [3 * 60 * MINUTE, '3 hours'],
        [49 * 60 * MINUTE, '2 days'],
    ])('offlineSince after %i ms says %s', (elapsed, words) => {
        expect(offlineSince({ state: 'offline', since, unsentDocuments: 0 }, STARTED + elapsed)).toBe(`offline from the Sync Server since ${since} (${words})`)
    })

    it('a notice names the time and what the answer can lack', () => {
        const notice = offlineNotice({ state: 'offline', since, unsentDocuments: 0 }, STARTED + 25 * MINUTE)
        expect(notice).toContain(`offline from the Sync Server since ${since} (25 minutes)`)
        expect(notice).toContain('a page or task it does not find may only be newer than the copy')
    })

    it('a connected copy, or a folder, has no notice', () => {
        expect(offlineNotice({ state: 'connected', since }, STARTED)).toBeNull()
        expect(offlineNotice(null, STARTED)).toBeNull()
    })

    it('the log says when the connection went and how long it was gone', () => {
        expect(connectionChangeLine({ connection: { state: 'offline', since, unsentDocuments: 0 }, offlineForMs: null })).toBe("lost the connection to the Sync Server; the tools answer from this computer's copy.")
        expect(connectionChangeLine({ connection: { state: 'connected', since }, offlineForMs: null })).toBe('connected to the Sync Server.')
        expect(connectionChangeLine({ connection: { state: 'connected', since }, offlineForMs: 25 * MINUTE })).toBe('connected to the Sync Server again, after 25 minutes offline.')
    })
})
