import { describe, expect, it } from 'vitest'

import { MissingGraphKeyError } from './keys'
import { NoVaultError } from './recovery-unlock'
import { inviteeNeedsOf, readShareAccess, vaultKeyForInvite } from './share-access'
import { createFakeSyncServer, seedAccount } from './testing/fake-sync-server'

type Account = Parameters<typeof inviteeNeedsOf>[0]

/** As much of an account as sharing reads. */
function account(overrides: { mode?: 'managed' | 'standalone'; status?: string; invitesNeedVerifiedEmail?: boolean; email?: string } = {}): NonNullable<Account> {
    return {
        principal: { email: overrides.email ?? 'owner@example.test' },
        authentication: { mode: overrides.mode ?? 'managed' },
        entitlement: { status: overrides.status ?? 'active' },
        ...(overrides.invitesNeedVerifiedEmail === undefined ? {} : { invitesNeedVerifiedEmail: overrides.invitesNeedVerifiedEmail }),
    } as unknown as NonNullable<Account>
}

const api = (me: Account | Error) => ({
    me: async () => {
        if (me instanceof Error || me === null) throw me ?? new Error('offline')
        return me
    },
})

describe('readShareAccess', () => {
    it("gives the Owner of a graph on an active plan what the invite dialog needs", async () => {
        const access = await readShareAccess(api(account({ invitesNeedVerifiedEmail: false })), Promise.resolve(true))

        expect(access).toEqual({
            ownEmail: 'owner@example.test',
            inviteeNeeds: { account: 'an EtherPK account', verifiedEmail: false },
        })
    })

    it('gives a Player nothing', async () => {
        expect(await readShareAccess(api(account()), Promise.resolve(false))).toBeNull()
    })

    it('gives nothing while the role could not be read', async () => {
        expect(await readShareAccess(api(account()), Promise.resolve(null))).toBeNull()
    })

    it('gives nothing while the account could not be read', async () => {
        expect(await readShareAccess(api(new Error('offline')), Promise.resolve(true))).toBeNull()
    })

    it("gives nothing while the Owner's plan takes no new Players", async () => {
        expect(await readShareAccess(api(account({ status: 'expired' })), Promise.resolve(true))).toBeNull()
    })

    it('does not ask for the account of somebody who is not the Owner', async () => {
        let asked = false
        const access = await readShareAccess(
            {
                me: async () => {
                    asked = true
                    return account()
                },
            },
            Promise.resolve(false),
        )

        expect(access).toBeNull()
        expect(asked).toBe(false)
    })
})

describe('inviteeNeedsOf', () => {
    it('names an account on this server for a standalone Sync Server', () => {
        expect(inviteeNeedsOf(account({ mode: 'standalone', invitesNeedVerifiedEmail: false }))).toEqual({
            account: 'an account on this server',
            verifiedEmail: false,
        })
    })

    it('names a verified address when the server does not say, which is the stricter reading', () => {
        expect(inviteeNeedsOf(account())).toEqual({ account: 'an EtherPK account', verifiedEmail: true })
        expect(inviteeNeedsOf(null)).toEqual({ account: 'an EtherPK account', verifiedEmail: true })
    })
})

describe('vaultKeyForInvite', () => {
    it("opens the account's Encryption Keys with the key this device holds and returns the vault key", async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey, wrapKey } = await seedAccount(server, 'account-1', { graphIds: ['garden'] })

        // Either key a device may hold opens them: the one the Recovery Code gives, or the vault key.
        expect(await vaultKeyForInvite(api, wrapKey, 'garden')).toEqual(vaultKey)
        expect(await vaultKeyForInvite(api, vaultKey, 'garden')).toEqual(vaultKey)
    })

    it('refuses a graph whose Graph Key the Encryption Keys do not hold', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, 'account-1', { graphIds: ['garden'] })

        await expect(vaultKeyForInvite(api, vaultKey, 'kitchen')).rejects.toBeInstanceOf(MissingGraphKeyError)
    })

    it('refuses an account with no Encryption Keys', async () => {
        const server = createFakeSyncServer()
        const { api, vaultKey } = await seedAccount(server, 'account-1', { graphIds: ['garden'] })
        server.accounts.get('account-1')!.vault = null

        await expect(vaultKeyForInvite(api, vaultKey, 'garden')).rejects.toBeInstanceOf(NoVaultError)
    })
})
