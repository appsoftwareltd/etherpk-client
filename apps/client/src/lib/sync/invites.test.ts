import { describe, expect, it, vi } from 'vitest'
import {
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fingerprint,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    openVault,
    toBase64Url,
} from '$lib/crypto'
import { acceptInvite, prepareInvite, sendInvite } from './invites'
import type { SyncApi } from './sync-api'

describe('invites', () => {
    it('owner seals the keyring to the invitee; the invitee unseals and joins', async () => {
        const invitee = generateIdentityKeyPair()
        const graphKeyring = createGraphKeyring('g1')

        // Invitee already has a vault (their own identity + Recovery Code).
        const code = generateRecoveryCode()
        const wrapKey = await deriveVaultWrapKey(code)
        let inviteeVault = {
            vault: toBase64Url(
                (
                    await encryptVault(
                        { identityPrivateKey: invitee.privateKey, identityPublicKey: invitee.publicKey, keyrings: [] },
                        wrapKey,
                    )
                ).envelope,
            ),
            version: 1,
        }
        let posted: { sealedKeyring: string } | null = null

        const api = {
            getIdentityByEmail: vi.fn(async () => ({ userId: 'invitee', publicKey: toBase64Url(invitee.publicKey) })),
            createInvite: vi.fn(async (_g: string, _e: string, sealedKeyring: string) => {
                posted = { sealedKeyring }
                return { id: 'inv-1' }
            }),
            getVault: vi.fn(async () => inviteeVault),
            putVault: vi.fn(async (v: string, expected: number) => {
                inviteeVault = { vault: v, version: expected + 1 }
                return inviteeVault.version
            }),
            acceptInvite: vi.fn(async () => 'g1'),
        } as unknown as SyncApi

        // Owner: prepare (shows fingerprint) then seal + send.
        const prep = await prepareInvite(api, 'invitee@test')
        expect(prep?.fingerprint).toBe(await fingerprint(invitee.publicKey))
        await sendInvite(api, 'g1', 'invitee@test', prep!.inviteePublicKey, graphKeyring)
        expect(posted).not.toBeNull()

        // Invitee: accept — unseal, fold into vault, activate.
        const accepted = await acceptInvite(
            api,
            { id: 'inv-1', graphId: 'g1', rootDocId: 'r1', sealedKeyring: posted!.sealedKeyring },
            invitee.privateKey,
            wrapKey,
            1,
        )
        expect(accepted.graphId).toBe('g1')
        // The invitee now holds the SAME graph key the owner sealed.
        expect(Buffer.from(accepted.keyring.epochs[0].key).equals(Buffer.from(graphKeyring.epochs[0].key))).toBe(true)
        // …and it is persisted in their vault.
        const opened = await openVault(fromBase64Url(inviteeVault.vault), wrapKey)
        expect(opened.vault.keyrings.map((k) => k.graphId)).toContain('g1')
    })

    it('prepareInvite returns null for an unknown invitee', async () => {
        const api = { getIdentityByEmail: vi.fn(async () => null) } as unknown as SyncApi
        expect(await prepareInvite(api, 'nobody@test')).toBeNull()
    })

    it('carries the graph name inside the sealed payload; legacy payloads still open', async () => {
        const { contextAad, sealToPublicKey, serializeKeyrings } = await import('$lib/crypto')
        const invitee = generateIdentityKeyPair()
        const graphKeyring = createGraphKeyring('g1')
        const code = generateRecoveryCode()
        const wrapKey = await deriveVaultWrapKey(code)
        let inviteeVault = {
            vault: toBase64Url(
                (
                    await encryptVault(
                        { identityPrivateKey: invitee.privateKey, identityPublicKey: invitee.publicKey, keyrings: [] },
                        wrapKey,
                    )
                ).envelope,
            ),
            version: 1,
        }
        let posted: string | null = null
        const api = {
            createInvite: vi.fn(async (_g: string, _e: string, sealedKeyring: string) => {
                posted = sealedKeyring
                return { id: 'inv-1' }
            }),
            getVault: vi.fn(async () => inviteeVault),
            putVault: vi.fn(async (v: string, expected: number) => {
                inviteeVault = { vault: v, version: expected + 1 }
                return inviteeVault.version
            }),
            acceptInvite: vi.fn(async () => 'g1'),
        } as unknown as SyncApi

        // v2: the name travels sealed and comes out at accept.
        await sendInvite(api, 'g1', 'invitee@test', invitee.publicKey, graphKeyring, 'Physics Notes')
        const accepted = await acceptInvite(
            api,
            { id: 'inv-1', graphId: 'g1', rootDocId: 'r1', sealedKeyring: posted! },
            invitee.privateKey,
            wrapKey,
            1,
        )
        expect(accepted.name).toBe('Physics Notes')
        // The name never appears in what the server stores (it is inside the sealed box).
        expect(Buffer.from(fromBase64Url(posted!)).toString('utf8')).not.toContain('Physics')

        // Legacy: a pre-v2 payload (bare keyring array) still opens; no name.
        const legacySealed = toBase64Url(
            await sealToPublicKey(invitee.publicKey, serializeKeyrings([graphKeyring]), contextAad('keyring-invite', 'graph:g1')),
        )
        const legacy = await acceptInvite(
            api,
            { id: 'inv-2', graphId: 'g1', rootDocId: 'r1', sealedKeyring: legacySealed },
            invitee.privateKey,
            wrapKey,
            2,
        )
        expect(legacy.name).toBeUndefined()
        expect(Buffer.from(legacy.keyring.epochs[0].key).equals(Buffer.from(graphKeyring.epochs[0].key))).toBe(true)
    })
})
