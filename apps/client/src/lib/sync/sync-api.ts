import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

// This module imports no other module of the Client: the Playwright fixtures reach it by relative
// path and resolve no `$lib` alias, so anything it named would have to be importable the same way.

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
    /**
     * Which kind of Sync Connection this API speaks for. Carried on every refusal, so the copy for
     * a refused credential can say "sign in again" or "add a new access token" without asking which
     * connection is selected: on a device with several, the one that failed may not be it.
     */
    kind?: 'managed' | 'custom'
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
    /** The newest Graph Key epoch (ADR 0127); absent from a server that predates epochs. */
    currentEpoch?: number
    /** A new epoch is due, which only the owner's Client can make. Reported to the owner only. */
    rotationDue?: boolean
}

/** Somebody a new Graph Key epoch is handed to, as `POST /epochs` names them (ADR 0127). */
export interface EpochRecipientJson {
    userId: string
    email: string
    role: 'owner' | 'player'
    status: 'active' | 'invited'
    identity: PublishedIdentityJson | null
}

/** One sealed, signed copy of a graph's keyring, as the owner's Client commits it (ADR 0127). */
export interface KeyHandoutCopyJson {
    recipientId: string
    sealedToPublicKey: string
    sealedKeyring: string
    signature: string
}

/** A copy of a graph's keyring waiting for this account (ADR 0127). */
export interface PendingKeyHandout {
    id: string
    graphId: string
    epoch: number
    ownerUserId: string
    ownerEmail: string | null
    /** The signer's identity as the directory publishes it now. */
    ownerIdentity: PublishedIdentityJson | null
    sealedToPublicKey: string
    sealedKeyring: string
    signature: string
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
        /** The kind of connection whose credential was presented, when the API was told. */
        readonly connectionKind?: 'managed' | 'custom',
    ) {
        super(message)
    }
}

/** A device approval request as an approving device sees it listed (ADR 0125). Keys are base64url. */
export interface PendingDeviceApproval {
    id: string
    commitment: string
    status: 'pending' | 'answered' | 'revealed'
    approverPublicKey?: string
    requesterPublicKey?: string
    createdAt: string
}

/** A published Sync Identity as the directory serves it (ADR 0126), keys in base64url. */
export interface PublishedIdentityJson {
    /** X25519: what invites and Graph Key epochs are sealed to. */
    publicKey: string
    /** Ed25519: what the account's signatures are checked with. Null until its Client next unlocks. */
    signingPublicKey: string | null
}

/**
 * A pending invite as the Sync Server lists it. Who sent it and when are absent from a server
 * that predates them; the graph's name is only in the sealed keyring (`inviteGraphName`).
 */
export interface PendingInvite {
    id: string
    graphId: string
    rootDocId: string
    sealedKeyring: string
    inviterEmail?: string | null
    createdAt?: string
    /** Who signed it, by account id (ADR 0126). */
    inviterUserId?: string
    /** The inviter's identity as the directory publishes it now, to check the signature with. */
    inviterIdentity?: PublishedIdentityJson | null
    /** The inviter's signature; null or absent for an invite sent before ADR 0126. */
    signature?: string | null
}

/**
 * A graph's member or invitee, as the owner-only roster lists them. A server that predates
 * `status` lists active members only.
 */
export interface GraphMember {
    userId: string
    email: string
    role: string
    status?: 'active' | 'invited'
    /** The pending invite behind an invited member, for the owner to cancel. */
    inviteId?: string
    /** Their identity as the directory publishes it now, to compare with the owner's pins (ADR 0126). */
    identity?: PublishedIdentityJson | null
}

/** A signed write of the vault, and of the identity with it when one is given (ADR 0126). */
export interface KeyWriteRequest {
    vault: string
    expectedVersion: number
    identity?: { publicKey: string; signingPublicKey: string }
    signature: string
    /**
     * Proof of holding the X25519 private key of the identity on record (`identityPossessionProof`),
     * which the server asks for while that identity has no signing key.
     */
    identityProof?: string
}

/** A Key Replacement as the Client sends it (ADR 0128): signed by the key on record and by the new one. */
export interface KeyReplaceRequest {
    vault: string
    expectedVersion: number
    identity: { publicKey: string; signingPublicKey: string }
    signature: string
    newSignature: string
}

/** What a Key Replacement did besides writing the keys (ADR 0128). */
export interface KeyReplaceResponse {
    version: number
    /** A token in place of the one this device signed in with, which the replacement revoked; null otherwise. */
    accessToken: string | null
    /** Invites to this account, sealed to the identity it no longer has, now declined. */
    declinedInvites: Array<{ graphId: string; inviterEmail: string | null }>
    /** Invites this account sent, signed by the key it no longer has, now withdrawn. */
    withdrawnInvites: Array<{ graphId: string; inviteeEmail: string | null }>
    /** Graphs this account owns, each now due a new Graph Key epoch. */
    ownedGraphIds: string[]
    /** Graphs others own that this account plays in: only their owners can start a new epoch. */
    sharedGraphs: Array<{ graphId: string; ownerEmail: string | null }>
}

/** An invite as the owner's Client sends it: sealed to the invitee's identity and signed (ADR 0126). */
export interface InviteRequest {
    graphId: string
    inviteeEmail: string
    inviteeUserId: string
    sealedKeyring: string
    sealedToPublicKey: string
    signature: string
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
            // Two shapes: a quota refusal carries its code at the top level beside
            // `error: 'quota_denied'`; every other refusal nests it, `{ error: { code, message } }`.
            const body = (await res.json().catch(() => null)) as {
                error?: { message?: string; code?: string } | 'quota_denied'
                code?: string
                retryable?: boolean
            } | null
            const nested = typeof body?.error === 'object' && body.error !== null ? body.error : null
            const code = nested?.code ?? body?.code
            const message = nested?.message ?? body?.code
            throw new SyncApiError(message ?? `HTTP ${res.status}`, res.status, code, body?.retryable === true, deps.kind)
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
        /**
         * The account's vault, its version, and the account id a write of it is signed over. While
         * the identity on record has no signing key, `identityProofKey` is the key the write that
         * gives it one proves the identity against.
         */
        getVault: () =>
            call<{ vault: string; version: number; principalId: string; identityProofKey?: string }>('/api/v1/sync/vault').catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        /**
         * Write the vault, and the identity with it, signed by the account's signing key (ADR 0126).
         * Resolves to the new version. A stale `expectedVersion` rejects with status 409.
         */
        putKeys: (write: KeyWriteRequest) =>
            call<{ version: number }>('/api/v1/sync/keys', {
                method: 'PUT',
                body: JSON.stringify(write),
            }).then((r) => r.version),
        /** Key Replacement (ADR 0128): new keys, and everything an old copy of them reached cut off. */
        replaceKeys: (replacement: KeyReplaceRequest) =>
            call<KeyReplaceResponse>('/api/v1/sync/keys/replace', {
                method: 'POST',
                body: JSON.stringify(replacement),
            }),
        getIdentity: (userId?: string) =>
            call<{ userId: string } & PublishedIdentityJson>(
                `/api/v1/sync/identity${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
            ).catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        /**
         * An invitee's identity key, for the owner of `graphId`. The address travels in the body
         * so it stays out of request and proxy logs; the server answers only a graph's owner and
         * rate-limits the lookup. `null` when nobody with that address can be invited yet.
         */
        getIdentityByEmail: (graphId: string, email: string) =>
            call<{ userId: string } & PublishedIdentityJson>('/api/v1/sync/identity/lookup', {
                method: 'POST',
                body: JSON.stringify({ graphId, email }),
            }).catch((e: unknown) => {
                if (e instanceof SyncApiError && e.status === 404) return null
                throw e
            }),
        createInvite: (invite: InviteRequest) =>
            call<{ id: string }>('/api/v1/sync/invites', {
                method: 'POST',
                body: JSON.stringify(invite),
            }),
        listInvites: () => call<{ invites: PendingInvite[] }>('/api/v1/sync/invites').then((r) => r.invites),
        acceptInvite: (id: string) =>
            call<{ graphId: string }>(`/api/v1/sync/invites/${id}/accept`, { method: 'POST' }).then((r) => r.graphId),
        /** Decline an invite sent to this account, or cancel one this account sent as the graph's owner. */
        withdrawInvite: (id: string) =>
            call<{ graphId: string; by: 'invitee' | 'owner' }>(`/api/v1/sync/invites/${id}`, { method: 'DELETE' }),
        graphMembers: (graphId: string) =>
            call<{ members: GraphMember[] }>(`/api/v1/sync/graphs/${graphId}/members`).then((r) => r.members),
        /** The owner removes a Player, or somebody invited (ADR 0127). A new epoch becomes due. */
        removeMember: (graphId: string, userId: string) =>
            call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}/members/${userId}`, { method: 'DELETE' }),
        // Graph Key epochs (ADR 0127): the owner's Client allocates, seals and commits; every
        // member's Client collects its copy of the keyring and acknowledges it once it is in the vault.
        allocateEpoch: (graphId: string) =>
            call<{ epoch: number; leaseUntil: string; recipients: EpochRecipientJson[] }>(
                `/api/v1/sync/graphs/${graphId}/epochs`,
                { method: 'POST' },
            ),
        commitEpoch: (graphId: string, epoch: number, copies: KeyHandoutCopyJson[]) =>
            call<{ epoch: number }>(`/api/v1/sync/graphs/${graphId}/epochs/${epoch}`, {
                method: 'POST',
                body: JSON.stringify({ copies }),
            }),
        /** The owner's **Rotate key**: make a new epoch due. */
        requestRotation: (graphId: string) =>
            call<{ ok: true }>(`/api/v1/sync/graphs/${graphId}/rotation`, { method: 'POST' }),
        listKeyHandouts: (graphId?: string) =>
            call<{ handouts: PendingKeyHandout[] }>(
                `/api/v1/sync/key-handouts${graphId ? `?graphId=${encodeURIComponent(graphId)}` : ''}`,
            ).then((r) => r.handouts),
        acknowledgeKeyHandout: (id: string) =>
            call<{ ok: true }>(`/api/v1/sync/key-handouts/${id}`, { method: 'DELETE' }),
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
        // Device approval (ADR 0125) — the server brokers blind: a commitment, two one-time
        // public keys, and an encrypted vault key only the two devices can open.
        createDeviceApproval: (commitment: string) =>
            call<{ id: string }>('/api/v1/sync/device-approvals', {
                method: 'POST',
                body: JSON.stringify({ commitment }),
            }),
        listDeviceApprovals: () =>
            call<{ approvals: PendingDeviceApproval[] }>('/api/v1/sync/device-approvals').then((r) => r.approvals),
        respondToDeviceApproval: (id: string, approverPublicKey: string) =>
            call<{ ok: true }>(`/api/v1/sync/device-approvals/${id}/respond`, {
                method: 'POST',
                body: JSON.stringify({ approverPublicKey }),
            }),
        revealDeviceApproval: (id: string, requesterPublicKey: string) =>
            call<{ ok: true }>(`/api/v1/sync/device-approvals/${id}/reveal`, {
                method: 'POST',
                body: JSON.stringify({ requesterPublicKey }),
            }),
        pollDeviceApproval: (id: string) =>
            call<{ status: string; approverPublicKey?: string; sealedVaultKey?: string }>(`/api/v1/sync/device-approvals/${id}`),
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
