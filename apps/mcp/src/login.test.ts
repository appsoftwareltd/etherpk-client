import { describe, expect, it } from 'vitest'

import { encryptVault, generateIdentityKeyPair, toBase64Url } from '$lib/crypto'
import { deriveVaultWrapKey, generateRecoveryCode } from '$lib/crypto/recovery-code'
import { approveDevice, approvalSas } from '$lib/sync/device-approval'
import type { SyncApi } from '$lib/sync/sync-api'

import { ApprovalAbandoned, unlockByDeviceApproval, unlockByRecoveryCode } from './login'

/**
 * Both unlock routes against a fake Sync Server holding a real vault: what the CLI prints,
 * what it caches, and that the Recovery Code itself is never what comes back.
 */
async function account() {
    const identity = generateIdentityKeyPair()
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)
    const encrypted = await encryptVault(
        { identityPrivateKey: identity.privateKey, identityPublicKey: identity.publicKey, keyrings: [] },
        wrapKey,
    )
    return { code, vaultKey: encrypted.vaultKey, envelope: toBase64Url(encrypted.envelope) }
}

describe('unlockByRecoveryCode', () => {
    it('derives the wrap key from the code and returns the vault key, not the wrap key', async () => {
        const a = await account()
        const api = { getVault: async () => ({ vault: a.envelope, version: 1 }) } as unknown as SyncApi
        const key = await unlockByRecoveryCode(api, a.code.toLowerCase().replaceAll('-', ' '))
        expect(toBase64Url(key)).toBe(toBase64Url(a.vaultKey))
    })

    it('rejects a wrong code and an account with no vault', async () => {
        const a = await account()
        const api = { getVault: async () => ({ vault: a.envelope, version: 1 }) } as unknown as SyncApi
        await expect(unlockByRecoveryCode(api, generateRecoveryCode())).rejects.toThrow('does not open this account')
        const empty = { getVault: async () => null } as unknown as SyncApi
        await expect(unlockByRecoveryCode(empty, a.code)).rejects.toThrow('no encryption keys')
    })
})

describe('unlockByDeviceApproval', () => {
    it('prints the SAS the approver sees, then claims and verifies the sealed vault key', async () => {
        const a = await account()
        let request: { id: string; ephemeralPublicKey: string } | null = null
        let sealed: string | undefined
        const api = {
            getVault: async () => ({ vault: a.envelope, version: 1 }),
            createDeviceApproval: async (ephemeralPublicKey: string) => {
                request = { id: 'appr-1', ephemeralPublicKey }
                return { id: 'appr-1' }
            },
            pollDeviceApproval: async () => (sealed ? { status: 'sealed', sealedVaultKey: sealed } : { status: 'pending' }),
            sealDeviceApproval: async (_id: string, blob: string) => {
                sealed = blob
                return { ok: true as const }
            },
        } as unknown as SyncApi
        const said: string[] = []
        let polls = 0
        const io = {
            say: (line: string) => said.push(line),
            sleep: async () => {
                // The approver (an unlocked tab) confirms after the second poll.
                if (++polls === 2 && request) {
                    const shown = await approvalSas({ id: request.id, ephemeralPublicKey: request.ephemeralPublicKey, createdAt: '' })
                    expect(said.join('\n')).toContain(shown)
                    await approveDevice(api, { id: request.id, ephemeralPublicKey: request.ephemeralPublicKey, createdAt: '' }, a.vaultKey)
                }
            },
        }
        const key = await unlockByDeviceApproval(api, { ...io, clientUrl: 'https://app.example.test' })
        expect(toBase64Url(key)).toBe(toBase64Url(a.vaultKey))
        // The instruction names the Client, not the Server, and says a tab of any page will do.
        expect(said.join('\n')).toContain('open EtherPK at https://app.example.test')
        expect(said.join('\n')).toMatch(/any page/)
    })

    it('says "open EtherPK in a browser" when the Server did not declare a Client', async () => {
        const said: string[] = []
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-3' }),
            pollDeviceApproval: async () => ({ status: 'rejected' }),
        } as unknown as SyncApi
        await expect(unlockByDeviceApproval(api, { say: (l) => said.push(l), sleep: async () => {} })).rejects.toThrow('rejected')
        expect(said.join('\n')).toContain('open EtherPK in a browser')
    })

    it('abandons the wait when asked, cancelling the approval server-side', async () => {
        const abort = new AbortController()
        let cancelled: string | null = null
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-4' }),
            pollDeviceApproval: async () => ({ status: 'pending' }),
            cancelDeviceApproval: async (id: string) => {
                cancelled = id
                return { ok: true as const }
            },
        } as unknown as SyncApi
        const io = {
            say: () => {},
            sleep: async () => {
                abort.abort() // the user pressed r during the wait
            },
            signal: abort.signal,
        }
        await expect(unlockByDeviceApproval(api, io)).rejects.toBeInstanceOf(ApprovalAbandoned)
        expect(cancelled).toBe('appr-4')
    })

    it('reports a rejection in words', async () => {
        const api = {
            createDeviceApproval: async () => ({ id: 'appr-2' }),
            pollDeviceApproval: async () => ({ status: 'rejected' }),
        } as unknown as SyncApi
        await expect(unlockByDeviceApproval(api, { say: () => {}, sleep: async () => {} })).rejects.toThrow('rejected')
    })
})
