import { describe, expect, it, vi } from 'vitest'
import { SyncApiError, createSyncApi } from './sync-api'

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('sync-api', () => {
    it('loads the authenticated account summary with the configured bearer token', async () => {
        const summary = {
            principal: {
                id: '019c9e42-0b89-7000-8000-000000000001',
                email: 'person@example.com',
                name: 'Person One',
                image: null,
            },
            authentication: { mode: 'managed', method: 'oidc' },
            entitlement: {
                plan: 'personal',
                status: 'active',
                limits: {
                    ownedGraphs: 10,
                    ownedStorageBytes: 1_000_000,
                    playersPerGraph: 5,
                    assetBytes: 100_000,
                    assetChunks: 128,
                },
                usage: { ownedGraphs: 2, ownedStorageBytes: 1234 },
            },
        }
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, summary))

        const result = await createSyncApi({
            baseUrl: 'https://sync.example.com/',
            token: 'access-token',
            fetch: fetchMock,
        }).me()

        expect(result).toEqual(summary)
        expect(fetchMock).toHaveBeenCalledWith('https://sync.example.com/api/v1/sync/me', expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        }))
    })

    it('publishes the name envelope with a PUT to the graph (ADR 0031, amended)', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }))
        const api = createSyncApi({ baseUrl: 'https://sync.example', token: 'epk_pat_abc', fetch: fetchMock })
        await api.setGraphName('g1', 'AQEAAAAA')
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://sync.example/api/v1/sync/graphs/g1/name')
        expect(init?.method).toBe('PUT')
        expect(JSON.parse(init?.body as string)).toEqual({ envelope: 'AQEAAAAA' })
    })

    it('lists the name envelope beside each graph when the server carries one', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () =>
            jsonResponse(200, {
                graphs: [
                    { id: 'g1', rootDocId: 'r1', role: 'owner', nameEnvelope: 'AQEAAAAA' },
                    { id: 'g2', rootDocId: 'r2', role: 'player', nameEnvelope: null },
                ],
            }),
        )
        const api = createSyncApi({ baseUrl: 'https://sync.example', token: 'epk_pat_abc', fetch: fetchMock })
        const graphs = await api.listGraphs()
        expect(graphs.map((graph) => graph.nameEnvelope)).toEqual(['AQEAAAAA', null])
    })

    it('sends the PAT as a bearer token and returns the created graph', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { id: 'g1', rootDocId: 'r1', role: 'owner' }))
        const api = createSyncApi({ baseUrl: 'https://sync.example/', token: 'epk_pat_abc', fetch: fetchMock })
        const graph = await api.createGraph()
        expect(graph.id).toBe('g1')
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://sync.example/api/v1/sync/graphs')
        expect(init?.method).toBe('POST')
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer epk_pat_abc' })
    })

    it('awaits a fresh bearer token for each request', async () => {
        const tokenSource = vi.fn()
            .mockResolvedValueOnce('access-token-1')
            .mockResolvedValueOnce('access-token-2')
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { graphs: [] }))
        const api = createSyncApi({ baseUrl: 'https://sync.example', token: tokenSource, fetch: fetchMock })

        await api.listGraphs()
        await api.listGraphs()

        expect(tokenSource).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer access-token-1' })
        expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer access-token-2' })
    })

    it('leaveGraph POSTs to the graph leave endpoint and surfaces refusals', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }))
        const api = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: fetchMock })
        await api.leaveGraph('g1')
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://s/api/v1/sync/graphs/g1/leave')
        expect(init?.method).toBe('POST')

        const owner = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: async () => jsonResponse(403, { error: { message: 'You own this graph — transfer ownership first' } }) })
        await expect(owner.leaveGraph('g1')).rejects.toThrow('transfer ownership first')
    })

    it('deleteGraph DELETEs the graph and surfaces owner-only refusals', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }))
        const api = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: fetchMock })
        await api.deleteGraph('g1')
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://s/api/v1/sync/graphs/g1')
        expect(init?.method).toBe('DELETE')

        const player = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: async () => jsonResponse(403, { error: { message: 'Only the owner can delete a graph' } }) })
        await expect(player.deleteGraph('g1')).rejects.toThrow('Only the owner')
    })

    it('maps a 404 vault to null and other errors to SyncApiError', async () => {
        const notFound = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: async () => jsonResponse(404, { error: { message: 'No vault' } }) })
        expect(await notFound.getVault()).toBeNull()

        const boom = createSyncApi({ baseUrl: 'https://s', token: 't', fetch: async () => jsonResponse(403, { error: { message: 'Forbidden' } }) })
        await expect(boom.mintSyncToken('g1')).rejects.toThrow(SyncApiError)
        await expect(boom.mintSyncToken('g1')).rejects.toThrow('Forbidden')
    })

    it('preserves typed retryable quota failures for the durable outbox', async () => {
        const api = createSyncApi({
            baseUrl: 'https://s',
            token: 't',
            fetch: async () => jsonResponse(403, {
                error: 'quota_denied',
                code: 'owned_storage_limit',
                retryable: true,
            }),
        })

        await expect(api.createGraph()).rejects.toMatchObject({
            status: 403,
            code: 'owned_storage_limit',
            retryable: true,
        })
    })
})
