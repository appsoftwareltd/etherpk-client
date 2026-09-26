import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

/**
 * The client's REST bridge to the sync server (plan Phase 4). Authenticates with a
 * Personal Access Token (bearer) — no cookies, so it works cross-origin. A PAT authenticates
 * but cannot decrypt (ADR 0026); every graph/vault/identity payload it fetches is ciphertext.
 *
 * Pure over an injected `fetch` + base URL so it unit-tests without a network.
 */
export interface SyncApiDeps {
    baseUrl: string
    token: string | (() => Promise<string>)
    fetch?: typeof fetch
}

export interface GraphStorageFigures {
    docBytes: number
    assetBytes: number
}

export interface ServerGraphRecord {
    id: string
    rootDocId: string
    role: string
    /** Storage Footprint (ADR 0033); absent from older servers. */
    storage?: GraphStorageFigures
    /**
     * The graph's name sealed under its Graph Key by a member's client (the name envelope,
     * ADR 0031 amended 2026-09-17): base64url, or null until one has been published. Opaque
     * to the server; `openGraphName` reads it where the keyring is.
     */
    nameEnvelope?: string | null
}

/** The quota-anticipating rollup over graphs the user owns (ADR 0033). */
export interface OwnedStorageTotals extends GraphStorageFigures {
    graphs: number
}

export class SyncApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
        readonly retryable = false,
    ) {
        super(message)
    }
}

export function createSyncApi(deps: SyncApiDeps) {
    const f = deps.fetch ?? fetch
    const base = deps.baseUrl.replace(/\/$/, '')

    async function call<T>(path: string, init?: RequestInit): Promise<T> {
        const token = typeof deps.token === 'string' ? deps.token : await deps.token()
        const res = await f(`${base}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
                ...init?.headers,
            },
        })
        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as {
                error?: { message?: string } | 'quota_denied'
                code?: string
                retryable?: boolean
            } | null
            const message = typeof body?.error === 'object'
                ? body.error.message
                : body?.code
            throw new SyncApiError(message ?? `HTTP ${res.status}`, res.status, body?.code, body?.retryable === true)
        }
        return (await res.json()) as T
    }

    return {
        /** Resolve the authenticated service-local account before loading account-scoped data. */
        me: () => call<SyncAccountSummary>('/api/v1/sync/me'),
        createGraph: () => call<ServerGraphRecord>('/api/v1/sync/graphs', { method: 'POST' }),
        listGraphs: () => call<{ graphs: ServerGraphRecord[] }>('/api/v1/sync/graphs').then((r) => r.graphs),
        /** Graphs plus the owned-storage rollup (one request - same endpoint as listGraphs). */
        graphsOverview: () =>
            call<{ graphs: ServerGraphRecord[]; ownedStorage: OwnedStorageTotals }>('/api/v1/sync/graphs'),
        graphStorage: (graphId: string) =>
            call<GraphStorageFigures>(`/api/v1/sync/graphs/${graphId}/storage`),
        /** Publish the name envelope for a graph this account is an active member of. */
        setGraphName: async (graphId: string, envelope: string): Promise<void> => {
            await call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}/name`, {
                method: 'PUT',
                body: JSON.stringify({ envelope }),
            })
        },
        mintSyncToken: (graphId: string) =>
            call<{ token: string }>('/api/v1/sync/token', {
                method: 'POST',
                body: JSON.stringify({ graphId }),
            }).then((r) => r.token),
        getVault: () =>
            call<{ vault: string; version: number }>('/api/v1/sync/vault').catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        putVault: (vault: string, expectedVersion: number) =>
            call<{ version: number }>('/api/v1/sync/vault', {
                method: 'PUT',
                body: JSON.stringify({ vault, expectedVersion }),
            }).then((r) => r.version),
        getIdentity: (userId?: string) =>
            call<{ userId: string; publicKey: string }>(
                `/api/v1/sync/identity${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
            ).catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        putIdentity: (publicKey: string) =>
            call<{ ok: true }>('/api/v1/sync/identity', {
                method: 'PUT',
                body: JSON.stringify({ publicKey }),
            }),
        /**
         * An invitee's identity key, for the owner of `graphId`. The address travels in the body
         * so it stays out of request and proxy logs; the server answers only a graph's owner and
         * rate-limits the lookup. `null` when nobody with that address can be invited yet.
         */
        getIdentityByEmail: (graphId: string, email: string) =>
            call<{ userId: string; publicKey: string }>('/api/v1/sync/identity/lookup', {
                method: 'POST',
                body: JSON.stringify({ graphId, email }),
            }).catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        createInvite: (graphId: string, inviteeEmail: string, sealedKeyring: string) =>
            call<{ id: string }>('/api/v1/sync/invites', {
                method: 'POST',
                body: JSON.stringify({ graphId, inviteeEmail, sealedKeyring }),
            }),
        listInvites: () =>
            call<{ invites: Array<{ id: string; graphId: string; rootDocId: string; sealedKeyring: string }> }>(
                '/api/v1/sync/invites',
            ).then((r) => r.invites),
        acceptInvite: (id: string) =>
            call<{ graphId: string }>(`/api/v1/sync/invites/${id}/accept`, { method: 'POST' }).then((r) => r.graphId),
        graphMembers: (graphId: string) =>
            call<{ members: Array<{ userId: string; email: string; role: string }> }>(
                `/api/v1/sync/graphs/${graphId}/members`,
            ).then((r) => r.members),
        leaveGraph: (graphId: string) =>
            call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}/leave`, { method: 'POST' }),
        deleteGraph: (graphId: string) =>
            call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}`, { method: 'DELETE' }),
        transferOwnership: (graphId: string, newOwnerUserId: string) =>
            call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}/transfer`, {
                method: 'POST',
                body: JSON.stringify({ newOwnerUserId }),
            }),
        resetPreview: () =>
            call<{ graphs: Array<{ graphId: string; otherMembers: Array<{ userId: string; email: string; role: string }>; solo: boolean }> }>(
                '/api/v1/sync/reset',
            ).then((r) => r.graphs),
        resetAccount: () =>
            call<{ ownedGraphsDeleted: number; membershipsDropped: number; hadVault: boolean }>('/api/v1/sync/reset', {
                method: 'POST',
            }),
        // Device approval (ADR 0026 flows) — the server brokers blind: an ephemeral public
        // key out, a sealed vault key back.
        createDeviceApproval: (ephemeralPublicKey: string) =>
            call<{ id: string }>('/api/v1/sync/device-approvals', {
                method: 'POST',
                body: JSON.stringify({ ephemeralPublicKey }),
            }),
        listDeviceApprovals: () =>
            call<{ approvals: Array<{ id: string; ephemeralPublicKey: string; createdAt: string }> }>(
                '/api/v1/sync/device-approvals',
            ).then((r) => r.approvals),
        pollDeviceApproval: (id: string) =>
            call<{ status: string; sealedVaultKey?: string }>(`/api/v1/sync/device-approvals/${id}`),
        sealDeviceApproval: (id: string, sealedVaultKey: string) =>
            call<{ ok: true }>(`/api/v1/sync/device-approvals/${id}`, {
                method: 'POST',
                body: JSON.stringify({ sealedVaultKey }),
            }),
        cancelDeviceApproval: (id: string) =>
            call<{ ok: true }>(`/api/v1/sync/device-approvals/${id}`, { method: 'DELETE' }),
    }
}

export type SyncApi = ReturnType<typeof createSyncApi>
