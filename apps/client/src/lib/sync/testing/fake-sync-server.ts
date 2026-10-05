/**
 * An in-memory Sync Server for the key, identity, invite and roster routes, for unit tests.
 *
 * It checks signatures by the same rules as the real one (`keys-store.ts` and the invites route
 * in the Sync Server, ADR 0126), so a Client test exercises its signed writes against those rules
 * rather than against a stub that accepts anything. Several accounts share one directory, as
 * they do on a real server, so an invite can go from one account's Client to another's.
 *
 * Its state is exposed for tests that play a hostile server: they can rewrite an invite or a
 * published identity directly, as such a server could.
 */
import { x25519 } from '@noble/curves/ed25519.js' // extensioned subpath — required by @noble/curves v2's exports map
import {
    IDENTITY_PROOF_LABEL,
    IDENTITY_PROOF_REFUSED_CODE,
    inviteTranscript,
    keyHandoutTranscript,
    keyReplaceTranscript,
    keyWriteTranscript,
} from '@appsoftwareltd/etherpk-shared'
import {
    type KeyVault,
    bytesEqual,
    concatBytes,
    createGraphKeyring,
    encryptVault,
    fromBase64Url,
    generateIdentityKeyPair,
    generateSigningKeyPair,
    identityHash,
    randomBytes,
    samePublicIdentity,
    sha256,
    toBase64Url,
    utf8,
    verifySignature,
} from '$lib/crypto'
import { writeSignedVault } from '../vault-update'
import {
    SyncApiError,
    type GraphMember,
    type InviteRequest,
    type KeyHandoutCopyJson,
    type KeyReplaceRequest,
    type KeyReplaceResponse,
    type KeyWriteRequest,
    type PendingInvite,
    type PendingKeyHandout,
    type PublishedIdentityJson,
    type SyncApi,
} from '../sync-api'

export interface FakeIdentity {
    publicKey: Uint8Array
    signingPublicKey: Uint8Array | null
}

export interface FakeAccount {
    id: string
    email: string
    vault: { bytes: Uint8Array; version: number } | null
    /** Oldest first; the last is the one the directory publishes. */
    identities: FakeIdentity[]
}

export interface FakeInvite {
    id: string
    graphId: string
    inviterId: string
    inviteeId: string
    sealedKeyring: Uint8Array
    signature: Uint8Array | null
    status: 'pending' | 'accepted' | 'declined'
}

export interface FakeMembership {
    role: 'owner' | 'player'
    status: 'active' | 'invited'
}

/** A graph's Graph Key epoch state (ADR 0127). */
export interface FakeEpochState {
    current: number
    rotationDue: boolean
    lease: number | null
}

/** One copy of a graph's keyring waiting for a member. */
export interface FakeHandout {
    id: string
    graphId: string
    recipientId: string
    ownerId: string
    epoch: number
    sealedToPublicKey: Uint8Array
    sealedKeyring: Uint8Array
    signature: Uint8Array
}

const encode = (identity: FakeIdentity): PublishedIdentityJson => ({
    publicKey: toBase64Url(identity.publicKey),
    signingPublicKey: identity.signingPublicKey ? toBase64Url(identity.signingPublicKey) : null,
})

export function createFakeSyncServer() {
    const accounts = new Map<string, FakeAccount>()
    const invites = new Map<string, FakeInvite>()
    /** graphId -> principalId -> membership */
    const graphs = new Map<string, Map<string, FakeMembership>>()
    const epochs = new Map<string, FakeEpochState>()
    /** By `${graphId}/${recipientId}`: the newest copy per member and graph, as the server keeps. */
    const handouts = new Map<string, FakeHandout>()
    /** The X25519 private key offered to each account to prove its identity against (identity-proof.ts on the Sync Server). */
    const proofKeys = new Map<string, Uint8Array>()
    let nextInvite = 1
    let nextHandout = 1

    function proofPrivateKey(principalId: string): Uint8Array {
        let key = proofKeys.get(principalId)
        if (!key) {
            key = randomBytes(32)
            proofKeys.set(principalId, key)
        }
        return key
    }

    /** The key offered while the identity on record has no signing key, as `GET /vault` answers. */
    function offeredProofKey(principalId: string): string | null {
        const onRecord = latest(principalId)
        if (!onRecord || onRecord.signingPublicKey) return null
        return toBase64Url(x25519.getPublicKey(proofPrivateKey(principalId)))
    }

    /** Whether `proof` shows its author holds the private key of `recordPublicKey`, by the Sync Server's rule. */
    async function proofHolds(principalId: string, recordPublicKey: Uint8Array, transcript: Uint8Array, proof: Uint8Array): Promise<boolean> {
        const privateKey = proofPrivateKey(principalId)
        let shared: Uint8Array
        try {
            shared = x25519.getSharedSecret(privateKey, recordPublicKey)
        } catch {
            return false
        }
        if (shared.every((b) => b === 0)) return false
        const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveBits'])
        const macKey = await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: concatBytes(x25519.getPublicKey(privateKey), recordPublicKey) as BufferSource,
                info: utf8(IDENTITY_PROOF_LABEL) as BufferSource,
            },
            ikm,
            256,
        )
        const hmac = await crypto.subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
        return crypto.subtle.verify('HMAC', hmac, proof as BufferSource, transcript as BufferSource)
    }

    const epochOf = (graphId: string): FakeEpochState => {
        let state = epochs.get(graphId)
        if (!state) {
            state = { current: 1, rotationDue: false, lease: null }
            epochs.set(graphId, state)
        }
        return state
    }

    /** Every active or invited member, the owner included: who a new epoch is handed to. */
    function recipientsOf(graphId: string) {
        return [...(graphs.get(graphId) ?? [])].map(([userId, membership]) => {
            const identity = latest(userId)
            return {
                userId,
                email: accounts.get(userId)?.email ?? '',
                role: membership.role,
                status: membership.status,
                identity: identity ? encode(identity) : null,
            }
        })
    }

    async function commitEpoch(principalId: string, graphId: string, epoch: number, copies: KeyHandoutCopyJson[]): Promise<{ epoch: number }> {
        if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can change the graph’s key', 403)
        const state = epochOf(graphId)
        if (state.lease !== epoch || state.current !== epoch - 1) throw new SyncApiError('lease lost', 409, 'epoch_lease_lost')
        const due = recipientsOf(graphId)
        const given = new Set(copies.map((c) => c.recipientId))
        if (due.length !== given.size || due.some((r) => !given.has(r.userId))) {
            throw new SyncApiError('members changed', 409, 'epoch_members_changed')
        }
        const owner = latest(principalId)
        for (const copy of copies) {
            const recipient = latest(copy.recipientId)
            if (!recipient || toBase64Url(recipient.publicKey) !== copy.sealedToPublicKey) {
                throw new SyncApiError('keys changed', 409, 'epoch_recipient_keys_changed')
            }
            const sealed = fromBase64Url(copy.sealedKeyring)
            const transcript = keyHandoutTranscript({
                graphId,
                epoch,
                ownerId: principalId,
                recipientId: copy.recipientId,
                sealedToPublicKey: fromBase64Url(copy.sealedToPublicKey),
                sealedHash: await sha256(sealed),
            })
            if (!owner?.signingPublicKey || !verifySignature(fromBase64Url(copy.signature), transcript, owner.signingPublicKey)) {
                throw new SyncApiError('not signed', 403, 'epoch_signature_refused')
            }
        }
        for (const copy of copies) {
            handouts.set(`${graphId}/${copy.recipientId}`, {
                id: `handout-${nextHandout++}`,
                graphId,
                recipientId: copy.recipientId,
                ownerId: principalId,
                epoch,
                sealedToPublicKey: fromBase64Url(copy.sealedToPublicKey),
                sealedKeyring: fromBase64Url(copy.sealedKeyring),
                signature: fromBase64Url(copy.signature),
            })
        }
        state.current = epoch
        state.lease = null
        state.rotationDue = false
        return { epoch }
    }

    function listHandouts(principalId: string, graphId?: string): PendingKeyHandout[] {
        return [...handouts.values()]
            .filter((h) => h.recipientId === principalId && (!graphId || h.graphId === graphId))
            .filter((h) => graphs.get(h.graphId)?.has(principalId))
            .map((h) => {
                const owner = latest(h.ownerId)
                return {
                    id: h.id,
                    graphId: h.graphId,
                    epoch: h.epoch,
                    ownerUserId: h.ownerId,
                    ownerEmail: accounts.get(h.ownerId)?.email ?? null,
                    ownerIdentity: owner ? encode(owner) : null,
                    sealedToPublicKey: toBase64Url(h.sealedToPublicKey),
                    sealedKeyring: toBase64Url(h.sealedKeyring),
                    signature: toBase64Url(h.signature),
                }
            })
    }

    function account(id: string, email = `${id}@example.com`): FakeAccount {
        let found = accounts.get(id)
        if (!found) {
            found = { id, email, vault: null, identities: [] }
            accounts.set(id, found)
        }
        return found
    }

    const latest = (id: string): FakeIdentity | null => accounts.get(id)?.identities.at(-1) ?? null

    function findByEmail(email: string): FakeAccount | null {
        const matches = [...accounts.values()].filter((a) => a.email.toLowerCase() === email.trim().toLowerCase())
        return matches.length === 1 ? matches[0] : null
    }

    function ownerOf(graphId: string): string | null {
        for (const [principalId, membership] of graphs.get(graphId) ?? []) if (membership.role === 'owner') return principalId
        return null
    }

    async function putKeys(principalId: string, write: KeyWriteRequest): Promise<number> {
        const acct = account(principalId)
        const onRecord = latest(principalId)
        const identity = write.identity
            ? { publicKey: fromBase64Url(write.identity.publicKey), signingPublicKey: fromBase64Url(write.identity.signingPublicKey) }
            : null
        const signingKey = onRecord?.signingPublicKey ?? identity?.signingPublicKey ?? null
        if (!signingKey) throw new SyncApiError('identity required', 400, 'identity_required')
        const vault = fromBase64Url(write.vault)
        const transcript = keyWriteTranscript({
            principalId,
            expectedVersion: write.expectedVersion,
            vaultHash: await sha256(vault),
            identityHash: identity ? await identityHash(identity) : null,
        })
        if (!verifySignature(fromBase64Url(write.signature), transcript, signingKey)) {
            throw new SyncApiError('not signed by the key on record', 403, 'key_signature_refused')
        }
        if (onRecord && !onRecord.signingPublicKey) {
            const proof = write.identityProof ? fromBase64Url(write.identityProof) : null
            if (!proof || !(await proofHolds(principalId, onRecord.publicKey, transcript, proof))) {
                throw new SyncApiError('no proof of holding the identity on record', 403, IDENTITY_PROOF_REFUSED_CODE)
            }
        }
        const conflict = write.expectedVersion === 0 ? acct.vault !== null : acct.vault?.version !== write.expectedVersion
        if (conflict) throw new SyncApiError('Version conflict', 409, 'version_conflict')
        acct.vault = { bytes: vault, version: (acct.vault?.version ?? 0) + 1 }
        const unchanged = onRecord?.signingPublicKey && identity && samePublicIdentity({ ...onRecord, signingPublicKey: onRecord.signingPublicKey }, identity)
        if (identity && !unchanged) acct.identities.push(identity)
        return acct.vault.version
    }

    /** Key Replacement (ADR 0128), by the rules and with the effects `key-replacement.ts` has on the Sync Server. */
    async function replaceKeys(principalId: string, request: KeyReplaceRequest): Promise<KeyReplaceResponse> {
        const acct = account(principalId)
        const onRecord = latest(principalId)
        if (!onRecord?.signingPublicKey) throw new SyncApiError('identity required', 400, 'identity_required')
        const identity = {
            publicKey: fromBase64Url(request.identity.publicKey),
            signingPublicKey: fromBase64Url(request.identity.signingPublicKey),
        }
        if (bytesEqual(identity.publicKey, onRecord.publicKey) || bytesEqual(identity.signingPublicKey, onRecord.signingPublicKey)) {
            throw new SyncApiError('A replacement must change both keys', 400, 'identity_unchanged')
        }
        const vault = fromBase64Url(request.vault)
        const transcript = keyReplaceTranscript({
            principalId,
            expectedVersion: request.expectedVersion,
            vaultHash: await sha256(vault),
            identityHash: await identityHash(identity),
        })
        if (!verifySignature(fromBase64Url(request.signature), transcript, onRecord.signingPublicKey)) {
            throw new SyncApiError('not signed by the key on record', 403, 'key_signature_refused')
        }
        if (!verifySignature(fromBase64Url(request.newSignature), transcript, identity.signingPublicKey)) {
            throw new SyncApiError('not signed by the new key', 400, 'new_identity_signature_refused')
        }
        if (acct.vault?.version !== request.expectedVersion) throw new SyncApiError('Version conflict', 409, 'version_conflict')
        acct.vault = { bytes: vault, version: acct.vault.version + 1 }
        acct.identities.push(identity)

        const declinedInvites: KeyReplaceResponse['declinedInvites'] = []
        const withdrawnInvites: KeyReplaceResponse['withdrawnInvites'] = []
        for (const invite of invites.values()) {
            if (invite.status !== 'pending') continue
            if (invite.inviteeId === principalId) {
                invite.status = 'declined'
                graphs.get(invite.graphId)?.delete(principalId)
                declinedInvites.push({ graphId: invite.graphId, inviterEmail: accounts.get(invite.inviterId)?.email ?? null })
            } else if (invite.inviterId === principalId) {
                invite.status = 'declined'
                graphs.get(invite.graphId)?.delete(invite.inviteeId)
                handouts.delete(`${invite.graphId}/${invite.inviteeId}`)
                epochOf(invite.graphId).rotationDue = true
                withdrawnInvites.push({ graphId: invite.graphId, inviteeEmail: accounts.get(invite.inviteeId)?.email ?? null })
            }
        }
        for (const [key, handout] of handouts) if (handout.recipientId === principalId) handouts.delete(key)
        const ownedGraphIds: string[] = []
        const sharedGraphs: KeyReplaceResponse['sharedGraphs'] = []
        for (const [graphId, members] of graphs) {
            const membership = members.get(principalId)
            if (membership?.role === 'owner') {
                epochOf(graphId).rotationDue = true
                ownedGraphIds.push(graphId)
            } else if (membership?.status === 'active') {
                const ownerId = ownerOf(graphId)
                sharedGraphs.push({ graphId, ownerEmail: ownerId ? (accounts.get(ownerId)?.email ?? null) : null })
            }
        }
        return { version: acct.vault.version, accessToken: null, declinedInvites, withdrawnInvites, ownedGraphIds, sharedGraphs }
    }

    async function createInvite(principalId: string, request: InviteRequest): Promise<{ id: string }> {
        if (ownerOf(request.graphId) !== principalId) throw new SyncApiError('Only the owner can invite', 403)
        const invitee = findByEmail(request.inviteeEmail)
        const inviteeIdentity = invitee ? latest(invitee.id) : null
        if (!invitee || !inviteeIdentity) throw new SyncApiError('not found', 404, 'identity_not_found')
        if (invitee.id !== request.inviteeUserId) throw new SyncApiError('changed', 409, 'invitee_changed')
        const sealedTo = fromBase64Url(request.sealedToPublicKey)
        if (!inviteeIdentity.signingPublicKey || toBase64Url(inviteeIdentity.publicKey) !== toBase64Url(sealedTo)) {
            throw new SyncApiError('keys changed', 409, 'invitee_keys_changed')
        }
        const sealedKeyring = fromBase64Url(request.sealedKeyring)
        const signature = fromBase64Url(request.signature)
        const inviterKey = latest(principalId)?.signingPublicKey
        const transcript = inviteTranscript({
            graphId: request.graphId,
            inviterId: principalId,
            inviteeId: invitee.id,
            inviteeIdentityHash: await identityHash({ publicKey: inviteeIdentity.publicKey, signingPublicKey: inviteeIdentity.signingPublicKey }),
            sealedHash: await sha256(sealedKeyring),
        })
        if (!inviterKey || !verifySignature(signature, transcript, inviterKey)) {
            throw new SyncApiError('not signed', 403, 'invite_signature_refused')
        }
        const membership = graphs.get(request.graphId)!
        const existing = membership.get(invitee.id)
        if (existing?.status === 'active') throw new SyncApiError('already a member', 409, 'invite_already_member')
        for (const invite of invites.values()) {
            if (invite.graphId === request.graphId && invite.inviteeId === invitee.id && invite.status === 'pending') invite.status = 'declined'
        }
        const id = `invite-${nextInvite++}`
        invites.set(id, { id, graphId: request.graphId, inviterId: principalId, inviteeId: invitee.id, sealedKeyring, signature, status: 'pending' })
        membership.set(invitee.id, { role: 'player', status: 'invited' })
        return { id }
    }

    function listInvites(principalId: string): PendingInvite[] {
        return [...invites.values()]
            .filter((invite) => invite.inviteeId === principalId && invite.status === 'pending')
            .map((invite) => {
                const inviterIdentity = latest(invite.inviterId)
                return {
                    id: invite.id,
                    graphId: invite.graphId,
                    rootDocId: `root-${invite.graphId}`,
                    sealedKeyring: toBase64Url(invite.sealedKeyring),
                    inviterEmail: accounts.get(invite.inviterId)?.email ?? null,
                    inviterUserId: invite.inviterId,
                    inviterIdentity: inviterIdentity ? encode(inviterIdentity) : null,
                    signature: invite.signature ? toBase64Url(invite.signature) : null,
                }
            })
    }

    function graphMembers(principalId: string, graphId: string): GraphMember[] {
        if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can list members', 403)
        return [...(graphs.get(graphId) ?? [])].map(([userId, membership]) => {
            const identity = latest(userId)
            return {
                userId,
                email: accounts.get(userId)?.email ?? '(email unavailable)',
                role: membership.role,
                status: membership.status,
                identity: identity ? encode(identity) : null,
            }
        })
    }

    /** The Sync API as the account `principalId` sees it: only the routes this fake serves. */
    function apiFor(principalId: string, email?: string): SyncApi {
        const acct = account(principalId, email)
        const api: Partial<SyncApi> = {
            me: async () =>
                ({
                    principal: { id: principalId, email: acct.email, name: null, image: null },
                    authentication: { mode: 'standalone' },
                }) as unknown as Awaited<ReturnType<SyncApi['me']>>,
            getVault: async () => {
                if (!acct.vault) return null
                const identityProofKey = offeredProofKey(principalId)
                return { vault: toBase64Url(acct.vault.bytes), version: acct.vault.version, principalId, ...(identityProofKey ? { identityProofKey } : {}) }
            },
            putKeys: (write) => putKeys(principalId, write),
            replaceKeys: (request) => replaceKeys(principalId, request),
            getIdentity: async (userId?: string) => {
                const id = userId ?? principalId
                const identity = latest(id)
                return identity ? { userId: id, ...encode(identity) } : null
            },
            getIdentityByEmail: async (graphId: string, address: string) => {
                if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can invite to this graph', 403)
                const found = findByEmail(address)
                const identity = found ? latest(found.id) : null
                return found && identity ? { userId: found.id, ...encode(identity) } : null
            },
            createInvite: (request) => createInvite(principalId, request),
            listInvites: async () => listInvites(principalId),
            acceptInvite: async (id: string) => {
                const invite = invites.get(id)
                if (!invite || invite.inviteeId !== principalId || invite.status !== 'pending') throw new SyncApiError('Not found', 404)
                invite.status = 'accepted'
                graphs.get(invite.graphId)!.set(principalId, { role: 'player', status: 'active' })
                return invite.graphId
            },
            graphMembers: async (graphId: string) => graphMembers(principalId, graphId),
            removeMember: async (graphId: string, userId: string) => {
                if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can remove members', 403)
                graphs.get(graphId)?.delete(userId)
                handouts.delete(`${graphId}/${userId}`)
                epochOf(graphId).rotationDue = true
                return { ok: true as const }
            },
            allocateEpoch: async (graphId: string) => {
                if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can change the graph’s key', 403)
                const state = epochOf(graphId)
                state.lease = state.current + 1
                return { epoch: state.lease, leaseUntil: new Date(Date.now() + 300_000).toISOString(), recipients: recipientsOf(graphId) }
            },
            commitEpoch: (graphId: string, epoch: number, copies: KeyHandoutCopyJson[]) => commitEpoch(principalId, graphId, epoch, copies),
            requestRotation: async (graphId: string) => {
                if (ownerOf(graphId) !== principalId) throw new SyncApiError('Only the owner can change the graph’s key', 403)
                epochOf(graphId).rotationDue = true
                return { ok: true as const }
            },
            listKeyHandouts: async (graphId?: string) => listHandouts(principalId, graphId),
            acknowledgeKeyHandout: async (id: string) => {
                for (const [key, handout] of handouts) {
                    if (handout.id === id && handout.recipientId === principalId) {
                        handouts.delete(key)
                        return { ok: true as const }
                    }
                }
                throw new SyncApiError('Not found', 404)
            },
        }
        return api as SyncApi
    }

    return {
        accounts,
        invites,
        graphs,
        epochs,
        handouts,
        epochOf,
        account,
        apiFor,
        /** The identity the directory publishes for `principalId` now. */
        published: latest,
        /** Register a graph owned by `ownerId`, as `POST /graphs` would. */
        addGraph(graphId: string, ownerId: string) {
            graphs.set(graphId, new Map([[ownerId, { role: 'owner', status: 'active' }]]))
        },
        /** Publish an identity for `principalId` without any check: a hostile server, or an account from before ADR 0126. */
        publishUnchecked(principalId: string, identity: FakeIdentity) {
            account(principalId).identities.push(identity)
        },
        /** Store a vault without any check: what an account from before ADR 0126 left behind. */
        storeVaultUnchecked(principalId: string, bytes: Uint8Array) {
            const acct = account(principalId)
            acct.vault = { bytes, version: (acct.vault?.version ?? 0) + 1 }
        },
    }
}

export type FakeSyncServer = ReturnType<typeof createFakeSyncServer>

/** A vault as a new account's Client mints it: an identity with both key pairs, and `graphIds`' keyrings. */
export function newVault(graphIds: string[] = []): KeyVault {
    const identity = generateIdentityKeyPair()
    const signing = generateSigningKeyPair()
    return {
        identityPrivateKey: identity.privateKey,
        identityPublicKey: identity.publicKey,
        signingPrivateKey: signing.privateKey,
        signingPublicKey: signing.publicKey,
        keyrings: graphIds.map(createGraphKeyring),
    }
}

/**
 * Give `principalId` keys on `server`, written the way a Client writes them (signed, with the
 * identity), and return what that account's device holds.
 */
export async function seedAccount(
    server: FakeSyncServer,
    principalId: string,
    options: { email?: string; graphIds?: string[]; wrapKey?: Uint8Array } = {},
): Promise<{ api: SyncApi; vault: KeyVault; vaultKey: Uint8Array; wrapKey: Uint8Array }> {
    const api = server.apiFor(principalId, options.email)
    const wrapKey = options.wrapKey ?? randomBytes(32)
    const vault = newVault(options.graphIds)
    const written = await writeSignedVault(api, vault, {
        principalId,
        expectedVersion: 0,
        seal: (content) => encryptVault(content, wrapKey),
        publishIdentity: true,
    })
    return { api, vault: written.vault, vaultKey: written.vaultKey, wrapKey }
}

/**
 * Give `principalId` keys as a Client from before ADR 0126 left them: a vault with no signing key,
 * and a published identity with none either.
 */
export async function seedLegacyAccount(
    server: FakeSyncServer,
    principalId: string,
    options: { email?: string; graphIds?: string[] } = {},
): Promise<{ api: SyncApi; vault: KeyVault; vaultKey: Uint8Array; wrapKey: Uint8Array }> {
    const api = server.apiFor(principalId, options.email)
    const wrapKey = randomBytes(32)
    const { signingPrivateKey: _private, signingPublicKey: _public, ...vault } = newVault(options.graphIds)
    const { envelope, vaultKey } = await encryptVault(vault, wrapKey)
    server.storeVaultUnchecked(principalId, envelope)
    server.publishUnchecked(principalId, { publicKey: vault.identityPublicKey, signingPublicKey: null })
    return { api, vault, vaultKey, wrapKey }
}
