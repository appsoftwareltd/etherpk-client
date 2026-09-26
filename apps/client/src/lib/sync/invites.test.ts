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
import { InviteForHeldGraphError, InviteeNotFoundError, acceptInvite, prepareInvite, sendInvite } from './invites'
import { SyncApiError, type SyncApi } from './sync-api'

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
        const prep = await prepareInvite(api, 'g1', 'invitee@test')
        // The lookup names the graph: the server answers only the owner of the graph being shared.
        expect(api.getIdentityByEmail).toHaveBeenCalledWith('g1', 'invitee@test')
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

    it('sendInvite reports an invitee who can no longer be found as such, not as a missing resource', async () => {
        // The server answers 404 identity_not_found when nobody with the address can be invited,
        // for example when the account went away between the lookup and the send.
        const api = {
            createInvite: vi.fn(async () => {
                throw new SyncApiError('No account with that address can be invited yet', 404)
            }),
        } as unknown as SyncApi
        const { generateIdentityKeyPair } = await import('$lib/crypto')
        const keyring = { graphId: 'g1', epochs: [{ epochId: 1, key: new Uint8Array(32) }] }

        await expect(sendInvite(api, 'g1', 'gone@test', generateIdentityKeyPair().publicKey, keyring as never))
            .rejects.toBeInstanceOf(InviteeNotFoundError)
    })

    it('prepareInvite returns null for an unknown invitee', async () => {
        const api = { getIdentityByEmail: vi.fn(async () => null) } as unknown as SyncApi
        expect(await prepareInvite(api, 'g1', 'nobody@test')).toBeNull()
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

        // Legacy: a pre-v2 payload (bare keyring array) still opens; no name. A second graph,
        // since an invite for a graph the vault already holds is refused.
        const legacyKeyring = createGraphKeyring('g2')
        const legacySealed = toBase64Url(
            await sealToPublicKey(invitee.publicKey, serializeKeyrings([legacyKeyring]), contextAad('keyring-invite', 'graph:g2')),
        )
        const legacy = await acceptInvite(
            api,
            { id: 'inv-2', graphId: 'g2', rootDocId: 'r2', sealedKeyring: legacySealed },
            invitee.privateKey,
            wrapKey,
            2,
        )
        expect(legacy.name).toBeUndefined()
        expect(Buffer.from(legacy.keyring.epochs[0].key).equals(Buffer.from(legacyKeyring.epochs[0].key))).toBe(true)
    })

    it('refuses an invite for a graph whose key the vault already holds, and keeps that key', async () => {
        // An invite carries no proof of who sealed it, so a server could seal a keyring it knows
        // for a graph the user already owns; accepting would replace the user's real key with it.
        const invitee = generateIdentityKeyPair()
        const heldKeyring = createGraphKeyring('g1')
        const code = generateRecoveryCode()
        const wrapKey = await deriveVaultWrapKey(code)
        const vault = {
            vault: toBase64Url((await encryptVault(
                { identityPrivateKey: invitee.privateKey, identityPublicKey: invitee.publicKey, keyrings: [heldKeyring] },
                wrapKey,
            )).envelope),
            version: 1,
        }
        let posted: { sealedKeyring: string } | null = null
        const api = {
            getIdentityByEmail: vi.fn(async () => ({ userId: 'invitee', publicKey: toBase64Url(invitee.publicKey) })),
            createInvite: vi.fn(async (_g: string, _e: string, sealedKeyring: string) => {
                posted = { sealedKeyring }
                return { id: 'inv-1' }
            }),
            getVault: vi.fn(async () => vault),
            putVault: vi.fn(),
            acceptInvite: vi.fn(),
        } as unknown as SyncApi
        const prep = await prepareInvite(api, 'g1', 'invitee@test')
        await sendInvite(api, 'g1', 'invitee@test', prep!.inviteePublicKey, createGraphKeyring('g1'))

        await expect(acceptInvite(
            api,
            { id: 'inv-1', graphId: 'g1', rootDocId: 'r1', sealedKeyring: posted!.sealedKeyring },
            invitee.privateKey,
            wrapKey,
            1,
        )).rejects.toBeInstanceOf(InviteForHeldGraphError)
        expect(api.putVault).not.toHaveBeenCalled()
        expect(api.acceptInvite).not.toHaveBeenCalled()
        const opened = await openVault(fromBase64Url(vault.vault), wrapKey)
        expect(Buffer.from(opened.vault.keyrings[0].epochs[0].key).equals(Buffer.from(heldKeyring.epochs[0].key))).toBe(true)
    })
})
