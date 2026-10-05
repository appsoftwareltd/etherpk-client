import { describe, expect, it, vi } from 'vitest'

import type { GraphRecord } from '$lib/storage'

import { createGraphKeyring, generateIdentityKeyPair, generateSigningKeyPair, toBase64Url } from '$lib/crypto'
import { sealGraphName } from '$lib/sync/graph-name-envelope'
import { withPin } from '$lib/sync/pins'
import { newVault } from '$lib/sync/testing/fake-sync-server'

import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

import {
    copyServer,
    countCopiesByServer,
    keyCopyNotice,
    loadSyncedGraphViews,
    memberTrust,
    persistableGraphRecord,
    serverGroupVisible,
    serverPlanGate,
    unlabelledGraphsToRead,
    type SyncedGraphView,
} from './graph-picker-helpers'

describe('graph picker helpers', () => {
    it('rebuilds server handles as clone-safe plain records', () => {
        const record: GraphRecord = {
            id: 'graph-a',
            name: 'Old name',
            backend: 'server',
            createdAt: 42,
            handle: { rootDocId: 'root-a' },
        }

        const persisted = persistableGraphRecord(record, 'New name')

        expect(persisted).toEqual({ ...record, name: 'New name' })
        expect(persisted.handle).not.toBe(record.handle)
    })

    it('retains the browser-owned filesystem handle', () => {
        const handle = { name: 'notes' } as FileSystemDirectoryHandle
        const record: GraphRecord = {
            id: 'graph-a',
            name: 'Old name',
            backend: 'filesystem',
            createdAt: 42,
            handle,
        }

        expect(persistableGraphRecord(record, 'New name').handle).toBe(handle)
    })

    it('projects server memberships with local names and isolated member failures', async () => {
        const api = {
            graphsOverview: vi.fn().mockResolvedValue({
                graphs: [
                    {
                        id: 'owned',
                        rootDocId: 'root-owned',
                        role: 'owner',
                        storage: { docBytes: 10, assetBytes: 20 },
                    },
                    {
                        id: 'shared',
                        rootDocId: 'root-shared',
                        role: 'player',
                    },
                ],
                ownedStorage: { graphs: 1, docBytes: 10, assetBytes: 20 },
            }),
            graphMembers: vi.fn().mockRejectedValue(new Error('offline')),
        }
        const local = [
            {
                id: 'owned',
                name: 'My graph',
                backend: 'server',
                createdAt: 42,
                handle: { rootDocId: 'root-owned' },
            },
        ] as GraphRecord[]

        await expect(loadSyncedGraphViews(api, local)).resolves.toEqual({
            graphs: [
                {
                    id: 'owned',
                    rootDocId: 'root-owned',
                    name: 'My graph',
                    nameSource: 'device',
                    hasNameEnvelope: false,
                    onDevice: true,
                    role: 'owner',
                    members: null,
                    storage: { docBytes: 10, assetBytes: 20 },
                    rotationDue: false,
                },
                {
                    id: 'shared',
                    rootDocId: 'root-shared',
                    name: 'Graph shared…',
                    nameSource: 'placeholder',
                    hasNameEnvelope: false,
                    onDevice: false,
                    role: 'player',
                    members: null,
                    storage: undefined,
                    rotationDue: false,
                },
            ],
            ownedStorage: { graphs: 1, docBytes: 10, assetBytes: 20 },
        })
        expect(api.graphMembers).toHaveBeenCalledOnce()
        expect(api.graphMembers).toHaveBeenCalledWith('owned')
    })

    it('picks the rows an unlocked device should read a name for: not here, unlabelled, key held', () => {
        const view = (id: string, onDevice: boolean, nameSource: SyncedGraphView['nameSource']) =>
            ({ id, onDevice, nameSource, rootDocId: `${id}-root` }) as SyncedGraphView
        const views = [
            view('a', false, 'placeholder'),
            view('b', true, 'device'),
            view('c', false, 'envelope'),
            view('d', false, 'placeholder'),
        ]

        const picked = unlabelledGraphsToRead(views, [createGraphKeyring('a'), createGraphKeyring('c')])

        expect(picked.map((entry) => [entry.view.id, entry.keyring.graphId])).toEqual([['a', 'a']])
    })

    describe('the name envelope (ADR 0031, amended)', () => {
        const GRAPH = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'

        async function overviewWith(nameEnvelope: string | null) {
            return {
                graphsOverview: vi.fn().mockResolvedValue({
                    graphs: [{ id: GRAPH, rootDocId: 'root', role: 'player', nameEnvelope }],
                    ownedStorage: { graphs: 0, docBytes: 0, assetBytes: 0 },
                }),
                graphMembers: vi.fn(),
            }
        }

        it('labels a graph this device never added from the envelope when the vault holds its key', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Physics Notes')))

            const { graphs } = await loadSyncedGraphViews(api, [], { keyrings: [keyring] })

            expect(graphs[0]).toMatchObject({ name: 'Physics Notes', nameSource: 'envelope', hasNameEnvelope: true, onDevice: false })
        })

        it('keeps the placeholder when the envelope cannot be read here', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Physics Notes')))

            const locked = await loadSyncedGraphViews(api, [])
            expect(locked.graphs[0]).toMatchObject({ name: `Graph ${GRAPH.slice(0, 8)}…`, nameSource: 'placeholder', hasNameEnvelope: true })

            const wrongKey = await loadSyncedGraphViews(api, [], { keyrings: [createGraphKeyring(GRAPH)] })
            expect(wrongKey.graphs[0]).toMatchObject({ nameSource: 'placeholder', hasNameEnvelope: true })
        })

        it('prefers the device record over the envelope for a graph on this device', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Renamed elsewhere')))
            const local = [
                { id: GRAPH, name: 'My graph', backend: 'server', createdAt: 42, handle: { rootDocId: 'root' } },
            ] as GraphRecord[]

            const { graphs } = await loadSyncedGraphViews(api, local, { keyrings: [keyring] })

            expect(graphs[0]).toMatchObject({ name: 'My graph', nameSource: 'device', hasNameEnvelope: true, onDevice: true })
        })

        it('reports a graph without an envelope so the page can backfill it from the device record', async () => {
            const api = await overviewWith(null)
            const local = [
                { id: GRAPH, name: 'My graph', backend: 'server', createdAt: 42, handle: { rootDocId: 'root' } },
            ] as GraphRecord[]

            const { graphs } = await loadSyncedGraphViews(api, local, { keyrings: [createGraphKeyring(GRAPH)] })

            expect(graphs[0]).toMatchObject({ name: 'My graph', nameSource: 'device', hasNameEnvelope: false })
        })
    })
})

describe('member trust (ADR 0126)', () => {
    const identity = () => ({ publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey })
    const published = (keys: ReturnType<typeof identity>) => ({
        publicKey: toBase64Url(keys.publicKey),
        signingPublicKey: toBase64Url(keys.signingPublicKey),
    })
    const member = (userId: string, keys: ReturnType<typeof identity> | null, role = 'player') => ({
        userId,
        email: `${userId}@example.com`,
        role,
        status: 'active' as const,
        identity: keys ? published(keys) : null,
    })

    it('reads each member’s key against the pins: verified, unverified or changed', () => {
        const pinned = identity()
        const vault = withPin(newVault(), 'pinned', pinned, { email: 'pinned@example.com', verified: true })
        const changed = withPin(vault, 'changed', identity(), { email: 'changed@example.com', verified: true })

        expect(memberTrust(member('pinned', pinned), changed)).toBe('verified')
        expect(memberTrust(member('stranger', identity()), changed)).toBe('unverified')
        expect(memberTrust(member('changed', identity()), changed)).toBe('changed')
    })

    it('says a member whose keys predate signing keys cannot be checked yet, and skips the owner', () => {
        const keys = identity()
        const old = { ...member('old', null), identity: { publicKey: toBase64Url(keys.publicKey), signingPublicKey: null } }

        expect(memberTrust(old, newVault())).toBe('not-upgraded')
        expect(memberTrust(member('me', keys, 'owner'), newVault())).toBeUndefined()
    })

    it('says a pinned member shown without a signing key has lost it, which no Verify can settle', () => {
        const keys = identity()
        const vault = withPin(newVault(), 'pinned', keys, { email: 'pinned@example.com', verified: false })
        const stripped = { ...member('pinned', null), identity: { publicKey: toBase64Url(keys.publicKey), signingPublicKey: null } }

        expect(memberTrust(stripped, vault)).toBe('signing-key-missing')
    })

    it('carries the trust on each member only when the pins were given, which needs the keys unlocked', async () => {
        const keys = identity()
        const api = {
            graphsOverview: vi.fn(async () => ({
                graphs: [{ id: 'graph-a', rootDocId: 'root-a', role: 'owner' }],
                ownedStorage: { graphs: 1, docBytes: 0, assetBytes: 0 },
            })),
            graphMembers: vi.fn(async () => [member('player', keys)]),
        }

        const locked = await loadSyncedGraphViews(api, [])
        const unlocked = await loadSyncedGraphViews(api, [], { pins: newVault() })

        expect(locked.graphs[0].members?.[0].trust).toBeUndefined()
        expect(unlocked.graphs[0].members?.[0].trust).toBe('unverified')
    })
})

describe('Graph Key epochs on the Graphs page (ADR 0127)', () => {
    it('carries the server’s word that an owned graph is due a new key', async () => {
        const api = {
            graphsOverview: vi.fn(async () => ({
                graphs: [
                    { id: 'graph-a', rootDocId: 'root-a', role: 'owner', rotationDue: true },
                    { id: 'graph-b', rootDocId: 'root-b', role: 'player' },
                ],
                ownedStorage: { graphs: 1, docBytes: 0, assetBytes: 0 },
            })),
            graphMembers: vi.fn(async () => []),
        }

        const { graphs } = await loadSyncedGraphViews(api, [])

        expect(graphs.map((graph) => graph.rotationDue)).toEqual([true, false])
    })

    it('says why a copy of a graph’s key was not used, and offers Verify when the owner’s keys changed', () => {
        const identity = { publicKey: generateIdentityKeyPair().publicKey, signingPublicKey: generateSigningKeyPair().publicKey }
        expect(
            keyCopyNotice({ kind: 'owner-key-changed', graphId: 'g', epoch: 2, ownerId: 'o', ownerEmail: 'owner@example.com', identity, fingerprint: 'AAAA' }),
        ).toEqual({
            text: 'owner@example.com’s security key changed, so EtherPK has not used the new key they sent for this graph. Compare security fingerprints with them, then select Verify.',
            verifyOwner: true,
        })
        expect(keyCopyNotice({ kind: 'unverifiable', graphId: 'g', epoch: 2, ownerEmail: null })).toMatchObject({ verifyOwner: false })
        expect(keyCopyNotice({ kind: 'added', graphId: 'g', epoch: 2 })).toBeNull()
        expect(keyCopyNotice({ kind: 'not-joined', graphId: 'g', epoch: 2 })).toBeNull()
    })
})

describe('the gate on a new synced graph, per Sync Server', () => {
    const host = 'sync.example.com'
    function account(plan: string, ownedGraphs: number, mode: 'managed' | 'standalone' = 'managed'): SyncAccountSummary {
        return {
            principal: { id: 'p1', email: 'you@example.com', name: null, image: null },
            authentication: mode === 'managed' ? { mode: 'managed', method: 'oidc' } : { mode: 'standalone', method: 'pat' },
            entitlement: {
                plan,
                status: 'active',
                limits: { ownedGraphs, ownedStorageBytes: 0, playersPerGraph: 0, assetBytes: 0, assetChunks: 0 },
                usage: { ownedGraphs: 0, ownedStorageBytes: 0 },
            },
        } as SyncAccountSummary
    }
    const signedIn = { authState: 'authenticated' as const, kind: 'managed' as const, host }

    it('lets a Sync+ account, and any self-hosted one, create', () => {
        expect(serverPlanGate({ ...signedIn, account: account('sync_plus', 25), planNotice: null, shownPlanNotice: null }))
            .toEqual({ syncPlusRequired: false, createBlockedReason: null })
        expect(serverPlanGate({ ...signedIn, kind: 'custom', account: account('unlimited', 1e9, 'standalone'), planNotice: null, shownPlanNotice: null }))
            .toEqual({ syncPlusRequired: false, createBlockedReason: null })
    })

    it('offers Sync+ to a Free account, and restarting it to a lapsed one', () => {
        expect(serverPlanGate({ ...signedIn, account: account('free', 0), planNotice: 'upsell', shownPlanNotice: 'upsell' }))
            .toEqual({ syncPlusRequired: true, createBlockedReason: 'Synced graphs need Sync+. Start it from Billing to create one.' })
        expect(serverPlanGate({ ...signedIn, account: account('free', 0), planNotice: 'ended', shownPlanNotice: 'ended' }).createBlockedReason)
            .toBe('Synced graphs need Sync+. Restart it from Billing to create one.')
    })

    it('never sells Sync+ to a plan still being confirmed, or one that cannot be', () => {
        const pending = serverPlanGate({ ...signedIn, account: account('remote-pending', 0), planNotice: 'pending', shownPlanNotice: 'pending' })
        expect(pending.syncPlusRequired).toBe(false)
        expect(pending.createBlockedReason).toContain('still confirming your plan')
        const unconfirmed = serverPlanGate({ ...signedIn, account: account('remote-unavailable', 0), planNotice: 'unconfirmed', shownPlanNotice: 'unconfirmed' })
        expect(unconfirmed.syncPlusRequired).toBe(false)
        expect(unconfirmed.createBlockedReason).toContain('cannot be confirmed')
    })

    it('names the server that is signed out, refusing, or not answering', () => {
        const base = { account: null, planNotice: null, shownPlanNotice: null }
        expect(serverPlanGate({ ...base, authState: 'signed-out', kind: 'managed', host }).createBlockedReason)
            .toBe('You are signed out of sync.example.com. Sign in to create a synced graph there.')
        expect(serverPlanGate({ ...base, authState: 'signed-out', kind: 'custom', host }).createBlockedReason)
            .toBe("sync.example.com did not accept this device's access token. Add a new one to create a synced graph there.")
        expect(serverPlanGate({ ...base, authState: 'unavailable', kind: 'custom', host }).createBlockedReason)
            .toBe('sync.example.com could not be reached. Try again when it answers.')
    })

    it('asks for the Device Passcode when the access token is protected by it (ADR 0129)', () => {
        expect(serverPlanGate({ account: null, planNotice: null, shownPlanNotice: null, authState: 'locked', kind: 'custom', host }).createBlockedReason)
            .toBe("Enter this device's passcode to create a synced graph on sync.example.com.")
    })

    it('blocks nothing while the account check is still in flight', () => {
        expect(serverPlanGate({ account: null, planNotice: null, shownPlanNotice: null, authState: 'checking', kind: 'managed', host }))
            .toEqual({ syncPlusRequired: false, createBlockedReason: null })
    })
})

describe('which Sync Server groups the Graphs tab shows', () => {
    const quiet = {
        firstRun: false,
        rows: 0,
        invites: 0,
        failed: false,
        authState: 'authenticated' as const,
        kind: 'managed' as const,
        planLine: false,
    }

    it('shows every server to a browser that already has graphs, empty or not', () => {
        expect(serverGroupVisible(quiet)).toBe(true)
        expect(serverGroupVisible({ ...quiet, authState: 'signed-out' })).toBe(true)
    })

    it('hides a server with nothing to show on a first visit: the first-run card offers the way in', () => {
        expect(serverGroupVisible({ ...quiet, firstRun: true })).toBe(false)
        expect(serverGroupVisible({ ...quiet, firstRun: true, authState: 'signed-out' })).toBe(false)
    })

    it('shows a server on a first visit when it has an invite, a problem, or a plan to explain', () => {
        const first = { ...quiet, firstRun: true }
        expect(serverGroupVisible({ ...first, invites: 1 })).toBe(true)
        expect(serverGroupVisible({ ...first, failed: true })).toBe(true)
        expect(serverGroupVisible({ ...first, planLine: true })).toBe(true)
        expect(serverGroupVisible({ ...first, authState: 'unavailable' })).toBe(true)
        // A custom server refusing its token: the first-run card cannot say how to fix that.
        expect(serverGroupVisible({ ...first, authState: 'signed-out', kind: 'custom' })).toBe(true)
        // Nor can it ask for the Device Passcode that protects the token.
        expect(serverGroupVisible({ ...first, authState: 'locked', kind: 'custom' })).toBe(true)
    })
})

describe('which Sync Server a synced copy in this browser belongs to', () => {
    const copy = (id: string, serverOrigin?: string): GraphRecord =>
        ({
            id,
            name: id,
            backend: 'server',
            createdAt: 1,
            handle: { rootDocId: `${id}-root` },
            ...(serverOrigin ? { serverScope: { serverOrigin, principalId: 'p1' } } : {}),
        }) as GraphRecord
    const held = ['https://sync.etherpk.com', 'https://notes.example.org']

    it('is the held server whose account it was written under', () => {
        expect(copyServer(copy('a', 'https://notes.example.org'), held)).toBe('https://notes.example.org')
    })

    it('is none for a server this device has forgotten, or a copy that names no server', () => {
        expect(copyServer(copy('b', 'https://gone.example.net'), held)).toBeNull()
        expect(copyServer(copy('c'), held)).toBeNull()
    })

    it('counts the copies per held server, and the rest apart', () => {
        const records = [
            copy('a', 'https://notes.example.org'),
            copy('b', 'https://notes.example.org'),
            copy('c', 'https://gone.example.net'),
            copy('d'),
        ]
        expect(countCopiesByServer(records, held)).toEqual({
            perServer: { 'https://notes.example.org': 2 },
            unheld: 2,
        })
    })
})
