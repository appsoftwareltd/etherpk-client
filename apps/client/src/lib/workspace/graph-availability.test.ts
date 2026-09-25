import { describe, expect, it } from 'vitest'

import type { GraphRecord } from '$lib/storage'

import { diagnoseMissingGraph } from './graph-availability'

const active = { serverOrigin: 'https://sync.example.com', principalId: 'principal-b' }
const previous = { serverOrigin: 'https://sync.example.com', principalId: 'principal-a' }

function stranded(id: string): GraphRecord {
    return {
        id,
        name: 'Cached under the old account',
        backend: 'server',
        createdAt: 1,
        handle: { rootDocId: `root-${id}` },
        serverScope: previous,
        membershipActive: true,
    }
}

describe('diagnoseMissingGraph', () => {
    it('is "available" when the server lists the graph and this device holds no record', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [],
            activeScope: () => active,
            listServerGraphs: async () => [{ id: 'g1', rootDocId: 'root-g1', role: 'owner' }],
        })

        expect(diagnosis).toEqual({ kind: 'available', rootDocId: 'root-g1', role: 'owner', staleRecord: false })
    })

    it('is still "available" when a stale record exists, and says so, since setting up overwrites it', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [stranded('g1')],
            activeScope: () => active,
            listServerGraphs: async () => [{ id: 'g1', rootDocId: 'root-g1', role: 'player' }],
        })

        expect(diagnosis).toEqual({ kind: 'available', rootDocId: 'root-g1', role: 'player', staleRecord: true })
    })

    it('names the other account when the record belongs to a Principal the server no longer lists it for', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [stranded('g1')],
            activeScope: () => active,
            listServerGraphs: async () => [],
        })

        expect(diagnosis).toEqual({
            kind: 'other-account',
            recordPrincipalId: 'principal-a',
            activePrincipalId: 'principal-b',
        })
    })

    it('is "not a member" when neither this device nor the server knows the graph', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [],
            activeScope: () => active,
            listServerGraphs: async () => [],
        })

        expect(diagnosis).toEqual({ kind: 'not-a-member' })
    })

    it('is "unknown" when the device has no sync configuration to ask with', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [],
            activeScope: () => null,
            listServerGraphs: null,
        })

        expect(diagnosis).toEqual({ kind: 'unknown', reason: 'no-sync-config' })
    })

    it('is "unknown" rather than "not a member" when the server cannot be reached', async () => {
        const diagnosis = await diagnoseMissingGraph('g1', {
            allRecords: async () => [stranded('g1')],
            activeScope: () => active,
            listServerGraphs: async () => {
                throw new TypeError('Failed to fetch')
            },
        })

        expect(diagnosis).toEqual({ kind: 'unknown', reason: 'server-unreachable' })
    })
})
