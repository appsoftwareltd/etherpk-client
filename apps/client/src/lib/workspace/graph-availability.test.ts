import { describe, expect, it } from 'vitest'

import { ManagedTokenError } from '$lib/auth/managed-token'
import type { GraphRecord, ServerGraphScope } from '$lib/storage'
import { SyncApiError } from '$lib/sync/sync-api'

import { diagnoseMissingGraph, type DiagnosisConnection, type MissingGraphDeps } from './graph-availability'

const SERVER = 'https://sync.example.com'
const MANAGED = 'https://sync.etherpk.com'
const active: ServerGraphScope = { serverOrigin: SERVER, principalId: 'principal-b' }
const previous: ServerGraphScope = { serverOrigin: SERVER, principalId: 'principal-a' }
const TEAM = 'https://team.example.org'
const teamAccount: ServerGraphScope = { serverOrigin: TEAM, principalId: 'principal-team' }

function held(id: string, scope: ServerGraphScope | undefined, membershipActive = true): GraphRecord {
    return {
        id,
        name: 'Held on this device',
        backend: 'server',
        createdAt: 1,
        handle: { rootDocId: `root-${id}` },
        ...(scope ? { serverScope: scope } : {}),
        membershipActive,
    }
}

type Listed = Array<{ id: string; rootDocId: string; role: string }>

/** A connection to `serverOrigin` as `account`, whose server lists `listed`. */
function connection(
    serverOrigin: string,
    account: ServerGraphScope,
    listed: Listed,
    overrides: Partial<DiagnosisConnection> = {},
): DiagnosisConnection {
    return {
        managed: false,
        serverOrigin,
        currentAccount: async () => account,
        listServerGraphs: async () => listed,
        ...overrides,
    }
}

/** A device connected to SERVER as `active`, holding `records`, whose server lists `listed`. */
function connected(
    records: GraphRecord[],
    listed: Listed,
    overrides: Partial<DiagnosisConnection> & { managedServerOrigin?: string | null; connections?: DiagnosisConnection[] } = {},
): MissingGraphDeps {
    const { managedServerOrigin = null, connections, ...connectionOverrides } = overrides
    return {
        allRecords: async () => records,
        connections: connections ?? [connection(SERVER, active, listed, connectionOverrides)],
        managedServerOrigin,
    }
}

describe('diagnoseMissingGraph', () => {
    it('is "available" when the server lists the graph and this device holds no record', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected([], [{ id: 'g1', rootDocId: 'root-g1', role: 'owner' }]))

        expect(diagnosis).toEqual({ kind: 'available', scope: active, rootDocId: 'root-g1', role: 'owner', staleRecord: false })
    })

    it('is "available" with a stale record when the device holds it under another account', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected(
            [held('g1', previous)],
            [{ id: 'g1', rootDocId: 'root-g1', role: 'player' }],
        ))

        expect(diagnosis).toEqual({ kind: 'available', scope: active, rootDocId: 'root-g1', role: 'player', staleRecord: true })
    })

    // Straight after a sign-in, the account check that records the active account can land after
    // the open starts, hiding the device's own record. The record is this account's, so
    // confirming the account is all it needs.
    it('is "ready" when the device holds the record for this account and the server lists it', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected(
            [held('g1', active, false), held('g2', active)],
            [{ id: 'g1', rootDocId: 'root-g1', role: 'owner' }, { id: 'g2', rootDocId: 'root-g2', role: 'player' }],
        ))

        expect(diagnosis).toEqual({ kind: 'ready', scope: active, memberships: ['g1', 'g2'] })
    })

    it('is "ready" for a record from before account scopes, which the membership list adopts', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected(
            [held('g1', undefined)],
            [{ id: 'g1', rootDocId: 'root-g1', role: 'owner' }],
        ))

        expect(diagnosis).toEqual({ kind: 'ready', scope: active, memberships: ['g1'] })
    })

    it('names the other account when the record belongs to a Principal the server no longer lists it for', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', previous)], []))

        expect(diagnosis).toEqual({
            kind: 'other-account',
            recordPrincipalId: 'principal-a',
            activePrincipalId: 'principal-b',
        })
    })

    // A removed player, or a graph its owner deleted: the record carries this account's own id,
    // so the graph is not another account's.
    it('is "no longer a member" when this account held the graph and the server no longer lists it', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', active)], []))

        expect(diagnosis).toEqual({ kind: 'no-longer-member', rootDocId: 'root-g1', name: 'Held on this device' })
    })

    it('is "not a member" when neither this device nor the server knows the graph', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected([], []))

        expect(diagnosis).toEqual({ kind: 'not-a-member' })
    })

    it('is "unknown" rather than "not a member" when the server cannot be reached', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', previous)], [], {
            listServerGraphs: async () => {
                throw new TypeError('Failed to fetch')
            },
        }))

        expect(diagnosis).toEqual({ kind: 'unknown', reason: 'server-unreachable' })
    })

    describe('without a working credential', () => {
        it('is "signed out" when the managed session has ended', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', { ...active, serverOrigin: MANAGED })], [], {
                managed: true,
                serverOrigin: MANAGED,
                managedServerOrigin: MANAGED,
                currentAccount: async () => {
                    throw new ManagedTokenError('Managed Sync sign-in is required', 401)
                },
            }))

            expect(diagnosis).toEqual({ kind: 'signed-out' })
        })

        it('is "signed out" on a managed deployment with no connection at all', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([], [], {
                connections: [],
                managedServerOrigin: MANAGED,
            }))

            expect(diagnosis).toEqual({ kind: 'signed-out' })
        })

        it('is "token rejected" when the server refuses this device\'s access token', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', active)], [], {
                currentAccount: async () => {
                    throw new SyncApiError('Unauthorized', 401)
                },
            }))

            expect(diagnosis).toEqual({ kind: 'token-rejected', serverOrigin: SERVER })
        })

        it('is "not connected" when the device holds the graph for a server it has no connection to', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', active)], [], { connections: [] }))

            expect(diagnosis).toEqual({ kind: 'not-connected', serverOrigin: SERVER })
        })

        it('is "not connected" on a managed deployment for a graph held from another server', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', active)], [], {
                connections: [],
                managedServerOrigin: MANAGED,
            }))

            expect(diagnosis).toEqual({ kind: 'not-connected', serverOrigin: SERVER })
        })

        it('is "unknown" when a self-hosted device has no connection and no record to go on', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([], [], { connections: [] }))

            expect(diagnosis).toEqual({ kind: 'unknown', reason: 'no-sync-config' })
        })
    })

    describe('on a device connected to several Sync Servers', () => {
        it("asks the graph's own server, whichever is selected", async () => {
            let askedSelected = false
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', teamAccount, false)], [], {
                connections: [
                    connection(SERVER, active, [], { listServerGraphs: async () => {
                        askedSelected = true
                        return []
                    } }),
                    connection(TEAM, teamAccount, [{ id: 'g1', rootDocId: 'root-g1', role: 'owner' }]),
                ],
            }))

            expect(diagnosis).toEqual({ kind: 'ready', scope: teamAccount, memberships: ['g1'] })
            expect(askedSelected).toBe(false)
        })

        it("is \"not connected\" to the graph's server when only another server is connected", async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([held('g1', teamAccount)], []))

            expect(diagnosis).toEqual({ kind: 'not-connected', serverOrigin: TEAM })
        })

        it('finds a graph with no record on whichever connected server lists it', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([], [], {
                connections: [
                    connection(SERVER, active, []),
                    connection(TEAM, teamAccount, [{ id: 'g1', rootDocId: 'root-g1', role: 'player' }]),
                ],
            }))

            expect(diagnosis).toEqual({ kind: 'available', scope: teamAccount, rootDocId: 'root-g1', role: 'player', staleRecord: false })
        })

        it('concludes nothing when a server that might hold the graph cannot be reached', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([], [], {
                connections: [
                    connection(SERVER, active, [], { listServerGraphs: async () => {
                        throw new TypeError('Failed to fetch')
                    } }),
                    connection(TEAM, teamAccount, []),
                ],
            }))

            expect(diagnosis).toEqual({ kind: 'unknown', reason: 'server-unreachable' })
        })

        it('names the refusal when a server that might hold the graph refused this device', async () => {
            const diagnosis = await diagnoseMissingGraph('g1', connected([], [], {
                connections: [
                    connection(SERVER, active, []),
                    connection(TEAM, teamAccount, [], { currentAccount: async () => {
                        throw new SyncApiError('Unauthorized', 401)
                    } }),
                ],
            }))

            expect(diagnosis).toEqual({ kind: 'token-rejected', serverOrigin: TEAM })
        })
    })
})
