import { describe, expect, it, vi } from 'vitest'
import {
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    openVault,
    sealSymmetric,
    contextAad,
    toBase64Url,
    utf8,
} from '$lib/crypto'
import { approvalSas, approveDevice, beginDeviceApproval, pollDeviceApproval } from './device-approval'
import type { SyncApi } from './sync-api'

/** An in-memory stand-in for the approval + vault REST surface (both devices share it). */
function fakeBackend(vaultBlob: Uint8Array) {
    let vault = { vault: toBase64Url(vaultBlob), version: 1 }
    const approvals = new Map<string, { ephemeralPublicKey: string; sealedVaultKey?: string; status: string }>()
    let seq = 0
    const api = {
        createDeviceApproval: vi.fn(async (ephemeralPublicKey: string) => {
            const id = `approval-${++seq}`
            approvals.set(id, { ephemeralPublicKey, status: 'pending' })
            return { id }
        }),
        listDeviceApprovals: vi.fn(async () =>
            [...approvals.entries()]
                .filter(([, a]) => a.status === 'pending')
                .map(([id, a]) => ({ id, ephemeralPublicKey: a.ephemeralPublicKey, createdAt: 'now' })),
        ),
        pollDeviceApproval: vi.fn(async (id: string) => {
            const a = approvals.get(id)!
            if (a.status === 'sealed') {
                const sealedVaultKey = a.sealedVaultKey!
                a.status = 'claimed'
                delete a.sealedVaultKey
                return { status: 'sealed', sealedVaultKey }
            }
            return { status: a.status }
        }),
        sealDeviceApproval: vi.fn(async (id: string, sealedVaultKey: string) => {
            const a = approvals.get(id)!
            a.sealedVaultKey = sealedVaultKey
            a.status = 'sealed'
            return { ok: true as const }
        }),
        cancelDeviceApproval: vi.fn(async (id: string) => {
            approvals.get(id)!.status = 'rejected'
            return { ok: true as const }
        }),
        getVault: vi.fn(async () => vault),
        putVault: vi.fn(async (v: string, expected: number) => {
            if (vault.version !== expected) throw new Error('conflict')
            vault = { vault: v, version: expected + 1 }
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

describe('device approval', () => {
    it('runs the full handshake: request → matching SAS → approve → verified unlock', async () => {
        const { envelope, vaultKey, wrapKey } = await seededVault()
        const { api } = fakeBackend(envelope)

        // New device: begin and display a SAS.
        const request = await beginDeviceApproval(api)
        expect(request.sas).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
        expect((await pollDeviceApproval(api, request)).state).toBe('waiting')

        // Approver: sees the request, derives the SAME SAS from the received key.
        const [pending] = await api.listDeviceApprovals()
        expect(await approvalSas(pending)).toBe(request.sas)

        // Approver holds only the WRAP key (code unlock) - approve seals the VAULT key.
        const cached = await approveDevice(api, pending, wrapKey)
        expect(Buffer.from(cached).equals(Buffer.from(vaultKey))).toBe(true)

        // New device: claims, opens, verifies - and the key provably opens the vault.
        const result = await pollDeviceApproval(api, request)
        expect(result.state).toBe('unlocked')
        if (result.state !== 'unlocked') throw new Error('unreachable')
        expect(Buffer.from(result.deviceKey).equals(Buffer.from(vaultKey))).toBe(true)
    })

    it('a rejected request reports rejected, never keys', async () => {
        const { envelope } = await seededVault()
        const { api } = fakeBackend(envelope)
        const request = await beginDeviceApproval(api)
        await api.cancelDeviceApproval(request.id)
        expect((await pollDeviceApproval(api, request)).state).toBe('rejected')
    })

    it('a sealed blob that does not open the vault fails the claim (no silent bad unlock)', async () => {
        const { envelope } = await seededVault()
        const { api, approvals } = fakeBackend(envelope)
        const request = await beginDeviceApproval(api)
        // A malicious/buggy seal: random bytes sealed to the right ephemeral key.
        const [pending] = await api.listDeviceApprovals()
        const { sealToPublicKey } = await import('$lib/crypto')
        const garbage = await sealToPublicKey(
            fromBase64Url(pending.ephemeralPublicKey),
            new Uint8Array(32).fill(1),
            contextAad('device-approval', `approval:${request.id}`),
        )
        approvals.get(request.id)!.sealedVaultKey = toBase64Url(garbage)
        approvals.get(request.id)!.status = 'sealed'
        await expect(pollDeviceApproval(api, request)).rejects.toThrow()
    })

    it('approving from a legacy vault upgrades it to v2 and seals the fresh vault key', async () => {
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
        const [pending] = await api.listDeviceApprovals()
        const cached = await approveDevice(api, pending, wrapKey)

        // The stored vault is now v2; the sealed key unlocks the new device.
        const upgraded = await openVault(fromBase64Url(getVault().vault), wrapKey)
        expect(upgraded.legacy).toBe(false)
        expect(Buffer.from(upgraded.vaultKey).equals(Buffer.from(cached))).toBe(true)
        const result = await pollDeviceApproval(api, request)
        expect(result.state).toBe('unlocked')
    })
})
