import { describe, expect, it, vi } from 'vitest'
import {
    approvalReplyKey,
    approvalTranscript,
    contextAad,
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    openVault,
    sealApprovalReply,
    sealSymmetric,
    toBase64Url,
    utf8,
} from '$lib/crypto'
import {
    ApprovalTamperedError,
    answerDeviceApproval,
    approveDevice,
    beginDeviceApproval,
    pollDeviceApproval,
    readApproverExchange,
} from './device-approval'
import { SyncApiError, type SyncApi } from './sync-api'

interface FakeApproval {
    commitment: string
    status: string
    approverPublicKey?: string
    requesterPublicKey?: string
    sealedVaultKey?: string
}

interface FakeOptions {
    /** Plays a server that hands the new device a different approver key than the one posted. */
    substituteApproverKey?: (posted: string) => string
    /** Plays a server that hands approving devices a different revealed key than the one posted. */
    substituteRequesterKey?: (posted: string) => string
}

/** An in-memory stand-in for the approval and vault routes (ADR 0125), shared by both devices. */
function fakeBackend(vaultBlob: Uint8Array, options: FakeOptions = {}) {
    let vault = { vault: toBase64Url(vaultBlob), version: 1, principalId: 'account-1' }
    const approvals = new Map<string, FakeApproval>()
    let seq = 0
    const conflict = () => new SyncApiError('conflict', 409)
    const api = {
        createDeviceApproval: vi.fn(async (commitment: string) => {
            const id = `approval-${++seq}`
            approvals.set(id, { commitment, status: 'pending' })
            return { id }
        }),
        listDeviceApprovals: vi.fn(async () =>
            [...approvals.entries()]
                .filter(([, a]) => ['pending', 'answered', 'revealed'].includes(a.status))
                .map(([id, a]) => ({
                    id,
                    commitment: a.commitment,
                    status: a.status,
                    ...(a.approverPublicKey ? { approverPublicKey: a.approverPublicKey } : {}),
                    ...(a.requesterPublicKey
                        ? { requesterPublicKey: options.substituteRequesterKey?.(a.requesterPublicKey) ?? a.requesterPublicKey }
                        : {}),
                    createdAt: 'now',
                })),
        ),
        respondToDeviceApproval: vi.fn(async (id: string, approverPublicKey: string) => {
            const a = approvals.get(id)!
            if (a.status !== 'pending') throw conflict()
            a.approverPublicKey = approverPublicKey
            a.status = 'answered'
            return { ok: true as const }
        }),
        revealDeviceApproval: vi.fn(async (id: string, requesterPublicKey: string) => {
            const a = approvals.get(id)!
            if (a.status !== 'answered') throw conflict()
            a.requesterPublicKey = requesterPublicKey
            a.status = 'revealed'
            return { ok: true as const }
        }),
        pollDeviceApproval: vi.fn(async (id: string) => {
            const a = approvals.get(id)!
            const approverPublicKey = a.approverPublicKey ? options.substituteApproverKey?.(a.approverPublicKey) ?? a.approverPublicKey : undefined
            if (a.status === 'sealed') {
                const sealedVaultKey = a.sealedVaultKey!
                a.status = 'claimed'
                delete a.sealedVaultKey
                return { status: 'sealed', approverPublicKey, sealedVaultKey }
            }
            return { status: a.status, ...(approverPublicKey ? { approverPublicKey } : {}) }
        }),
        sealDeviceApproval: vi.fn(async (id: string, sealedVaultKey: string) => {
            const a = approvals.get(id)!
            if (a.status !== 'revealed') throw conflict()
            a.sealedVaultKey = sealedVaultKey
            a.status = 'sealed'
            return { ok: true as const }
        }),
        cancelDeviceApproval: vi.fn(async (id: string) => {
            approvals.get(id)!.status = 'rejected'
            return { ok: true as const }
        }),
        getVault: vi.fn(async () => vault),
        // Signatures are checked by the fake Sync Server in vault-update's tests; here only the write matters.
        putKeys: vi.fn(async (write: { vault: string; expectedVersion: number }) => {
            if (vault.version !== write.expectedVersion) throw conflict()
            vault = { vault: write.vault, version: write.expectedVersion + 1, principalId: 'account-1' }
            return vault.version
        }),
    } as unknown as SyncApi
    return { api, approvals, getVault: () => vault }
}

async function seededVault() {
    const identity = generateIdentityKeyPair()
    const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
    const { envelope, vaultKey } = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings: [createGraphKeyring('g1')] },
        wrapKey,
    )
    return { envelope, vaultKey, wrapKey, identity }
}

/** The one request an approving device sees listed. */
async function listed(api: SyncApi) {
    const [pending] = await api.listDeviceApprovals()
    return pending
}

describe('device approval (ADR 0125)', () => {
    it('runs the full exchange: commitment, answer, reveal, the same code on both screens, approval', async () => {
        const { envelope, vaultKey, wrapKey } = await seededVault()
        const { api } = fakeBackend(envelope)

        // New device: posts only a commitment, so there is no code yet.
        const request = await beginDeviceApproval(api)
        expect((await pollDeviceApproval(api, request)).state).toBe('waiting')

        // Approving device: answers with a one-time key of its own.
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        expect(session.exchange).toBeUndefined()

        // New device: reveals its key and shows the code.
        const shown = await pollDeviceApproval(api, request)
        expect(shown.state).toBe('code')
        if (shown.state !== 'code') throw new Error('unreachable')
        expect(shown.sas).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)

        // Approving device: checks the reveal against the commitment and shows the same code.
        const exchange = await readApproverExchange(session, await listed(api))
        expect(exchange?.sas).toBe(shown.sas)

        // The approving device holds only the wrap key (a code unlock); approval sends the vault key.
        const cached = await approveDevice(api, session, wrapKey)
        expect(Buffer.from(cached).equals(Buffer.from(vaultKey))).toBe(true)

        const result = await pollDeviceApproval(api, request)
        expect(result.state).toBe('approved')
        if (result.state !== 'approved') throw new Error('unreachable')
        expect(result.sas).toBe(shown.sas)
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })

    it('a server that substitutes the approving device key makes the two codes differ', async () => {
        const { envelope } = await seededVault()
        const intruder = generateIdentityKeyPair()
        const { api } = fakeBackend(envelope, { substituteApproverKey: () => toBase64Url(intruder.publicKey) })
        const request = await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        const shown = await pollDeviceApproval(api, request)
        if (shown.state !== 'code') throw new Error('unreachable')
        const exchange = await readApproverExchange(session, await listed(api))
        expect(exchange?.sas).not.toBe(shown.sas)
    })

    it('a server that substitutes the revealed key is caught by the commitment', async () => {
        const { envelope } = await seededVault()
        const intruder = generateIdentityKeyPair()
        const { api } = fakeBackend(envelope, { substituteRequesterKey: () => toBase64Url(intruder.publicKey) })
        const request = await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        await pollDeviceApproval(api, request)
        await expect(readApproverExchange(session, await listed(api))).rejects.toBeInstanceOf(ApprovalTamperedError)
    })

    it('a reply sealed for any other approving key does not open on the new device', async () => {
        const { envelope, vaultKey, wrapKey } = await seededVault()
        const intruder = generateIdentityKeyPair()
        // The server shows the new device its own key, but relays the real device's reply.
        const { api } = fakeBackend(envelope, { substituteApproverKey: () => toBase64Url(intruder.publicKey) })
        const request = await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        await pollDeviceApproval(api, request)
        await readApproverExchange(session, await listed(api))
        await approveDevice(api, session, wrapKey)
        await expect(pollDeviceApproval(api, request)).rejects.toThrow()
        expect(vaultKey).toBeDefined()
    })

    it('only the first approving device to answer handles a request', async () => {
        const { envelope } = await seededVault()
        const { api } = fakeBackend(envelope)
        await beginDeviceApproval(api)
        const pending = await listed(api)
        const first = await answerDeviceApproval(api, pending)
        const second = await answerDeviceApproval(api, pending)
        expect(first).not.toBe('taken')
        expect(second).toBe('taken')
    })

    it('a rejected request reports rejected, never keys', async () => {
        const { envelope } = await seededVault()
        const { api } = fakeBackend(envelope)
        const request = await beginDeviceApproval(api)
        await api.cancelDeviceApproval(request.id)
        expect((await pollDeviceApproval(api, request)).state).toBe('rejected')
    })

    it('a reply that opens but holds a key for no vault of this account fails the claim', async () => {
        const { envelope } = await seededVault()
        const { api, approvals } = fakeBackend(envelope)
        const request = await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        await pollDeviceApproval(api, request)
        const exchange = await readApproverExchange(session, await listed(api))
        if (!exchange) throw new Error('unreachable')
        // A properly sealed reply carrying a key that opens nothing.
        const transcript = await approvalTranscript({
            approvalId: request.id,
            commitment: request.commitment,
            approverPublicKey: session.publicKey,
            requesterPublicKey: exchange.requesterPublicKey,
        })
        const replyKey = await approvalReplyKey(session.privateKey, exchange.requesterPublicKey, transcript)
        const reply = await sealApprovalReply(replyKey, new Uint8Array(32).fill(1), request.id)
        approvals.get(request.id)!.sealedVaultKey = toBase64Url(reply)
        approvals.get(request.id)!.status = 'sealed'
        await expect(pollDeviceApproval(api, request)).rejects.toThrow()
    })

    it('approving from a legacy vault upgrades it to v2 and sends the fresh vault key', async () => {
        // A phase-1 blob: content directly under the wrap key, no vault key yet.
        const identity = generateIdentityKeyPair()
        const wrapKey = await deriveVaultWrapKey(generateRecoveryCode())
        const legacyBlob = await sealSymmetric({
            key: wrapKey,
            epochId: 0,
            plaintext: utf8(
                JSON.stringify({
                    identityPrivateKey: toBase64Url(identity.privateKey),
                    identityPublicKey: toBase64Url(identity.publicKey),
                    keyrings: '[]',
                }),
            ),
            aad: contextAad('vault'),
        })
        const { api, getVault } = fakeBackend(legacyBlob)

        const request = await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        await pollDeviceApproval(api, request)
        await readApproverExchange(session, await listed(api))
        const cached = await approveDevice(api, session, wrapKey)

        const upgraded = await openVault(fromBase64Url(getVault().vault), wrapKey)
        expect(upgraded.legacy).toBe(false)
        expect(Buffer.from(upgraded.vaultKey).equals(Buffer.from(cached))).toBe(true)
        expect((await pollDeviceApproval(api, request)).state).toBe('approved')
    })

    it('refuses to approve before the new device has revealed its key', async () => {
        const { envelope, wrapKey } = await seededVault()
        const { api } = fakeBackend(envelope)
        await beginDeviceApproval(api)
        const session = await answerDeviceApproval(api, await listed(api))
        if (session === 'taken') throw new Error('unreachable')
        await expect(approveDevice(api, session, wrapKey)).rejects.toThrow()
    })
})
