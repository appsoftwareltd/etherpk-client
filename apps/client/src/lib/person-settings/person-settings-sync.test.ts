import { describe, expect, it, vi } from 'vitest'

import { openVault } from '$lib/crypto'
import { createFakeSyncServer, seedAccount } from '$lib/sync/testing/fake-sync-server'
import { updateVault } from '$lib/sync/vault-update'

import { createPersonSettings, extensionSettingKey } from './person-settings'
import { createPersonSettingsSync, type PersonSettingsAccount } from './person-settings-sync'

// The person's settings travel in their account's vault (ADR 0134), so they follow the person to
// every device where the account syncs.

function memoryStorage(): Storage {
    const items = new Map<string, string>()
    return {
        get length() {
            return items.size
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, value),
    }
}

const KEY = extensionSettingKey('maps', 'mapbox-token')

/** One device: its own settings, and a sync with whatever account `account` says. */
function device(account: () => PersonSettingsAccount | null) {
    let time = 1_000
    const storage = memoryStorage()
    const settings = createPersonSettings(() => storage, () => time)
    return { settings, sync: createPersonSettingsSync(settings, account), at: (next: number) => (time = next) }
}

async function accountWithVault(principalId = 'account-1') {
    const server = createFakeSyncServer()
    const seeded = await seedAccount(server, principalId)
    const target: PersonSettingsAccount = { id: `https://sync.example ${principalId}`, api: seeded.api, heldKey: seeded.vaultKey }
    /** The settings the account's vault holds now. */
    const vaultSettings = async () => {
        const stored = server.accounts.get(principalId)!.vault!
        return (await openVault(stored.bytes, seeded.vaultKey)).vault.settings
    }
    return { server, seeded, target, vaultSettings }
}

describe('syncing the person’s settings', () => {
    it('stays on the device where there is no account, or its keys are locked here', async () => {
        const alone = device(() => null)
        expect(alone.sync.state()).toBe('device')
        await alone.sync.sync()
        expect(alone.sync.state()).toBe('device')

        const { target } = await accountWithVault()
        const locked = device(() => ({ ...target, heldKey: null }))
        expect(locked.sync.state()).toBe('locked')
        locked.settings.set(KEY, 'pk.waits')
        await locked.sync.sync()
        expect(locked.sync.state()).toBe('locked')
        expect(locked.settings.hasPending()).toBe(true)
    })

    it('stays on the device for an account with no vault, which syncs no graph yet', async () => {
        const server = createFakeSyncServer()
        const { settings, sync } = device(() => ({ id: 'https://sync.example newcomer', api: server.apiFor('newcomer'), heldKey: new Uint8Array(32) }))
        settings.set(KEY, 'pk.waits')
        await sync.sync()
        expect(sync.state()).toBe('device')
        expect(settings.hasPending()).toBe(true)
    })

    it('carries a setting from one device to another through the vault', async () => {
        const { target, vaultSettings } = await accountWithVault()
        const laptop = device(() => target)
        const phone = device(() => target)
        expect(laptop.sync.state()).toBe('syncing')

        laptop.settings.set(KEY, 'pk.from-laptop')
        await laptop.sync.sync()
        expect(laptop.sync.state()).toBe('synced')
        expect(laptop.settings.hasPending()).toBe(false)
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.from-laptop', changedAt: 1_000 } })

        await phone.sync.sync()
        expect(phone.settings.get(KEY)).toBe('pk.from-laptop')
    })

    it('keeps the later of two changes, a clearing included, whichever device syncs first', async () => {
        const { target, vaultSettings } = await accountWithVault()
        const laptop = device(() => target)
        const phone = device(() => target)
        laptop.settings.set(KEY, 'pk.first')
        await laptop.sync.sync()
        await phone.sync.sync()

        // Both change it offline; the phone's change is the later one, but the laptop syncs first.
        phone.at(5_000)
        phone.settings.set(KEY, null)
        laptop.at(3_000)
        laptop.settings.set(KEY, 'pk.second')
        await laptop.sync.sync()
        await phone.sync.sync()
        await laptop.sync.sync()

        expect(laptop.settings.get(KEY)).toBeUndefined()
        expect(phone.settings.get(KEY)).toBeUndefined()
        expect(await vaultSettings()).toEqual({ [KEY]: { value: null, changedAt: 5_000 } })
    })

    it('keeps the rest of the vault as it was, and writes nothing when the vault has everything', async () => {
        const { seeded, target } = await accountWithVault()
        const putKeys = vi.spyOn(seeded.api, 'putKeys')
        const { settings, sync } = device(() => target)
        await sync.sync()
        expect(putKeys).not.toHaveBeenCalled()

        settings.set(KEY, 'pk.one')
        await sync.sync()
        const update = await updateVault(seeded.api, seeded.vaultKey, { apply: () => null })
        expect(update.vault.keyrings.map((keyring) => keyring.graphId)).toEqual(seeded.vault.keyrings.map((keyring) => keyring.graphId))
        expect(update.vault.signingPublicKey).toEqual(seeded.vault.signingPublicKey)
    })

    it('waits while the account cannot be reached, and sends the change once it can', async () => {
        const { seeded, target, vaultSettings } = await accountWithVault()
        const { settings, sync } = device(() => target)
        const getVault = vi.spyOn(seeded.api, 'getVault').mockRejectedValueOnce(new TypeError('Failed to fetch'))
        settings.set(KEY, 'pk.offline')
        await sync.sync()
        expect(sync.state()).toBe('waiting')
        expect(settings.hasPending()).toBe(true)

        await sync.sync()
        expect(getVault).toHaveBeenCalledTimes(2)
        expect(sync.state()).toBe('synced')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.offline', changedAt: 1_000 } })
    })

    it('runs a sync asked for during one after it, and tells its listeners how it went', async () => {
        const { seeded, target } = await accountWithVault()
        const getVault = vi.spyOn(seeded.api, 'getVault')
        const { sync } = device(() => target)
        const heard = vi.fn()
        sync.subscribe(heard)
        const first = sync.sync()
        const second = sync.sync()
        const third = sync.sync()
        await Promise.all([first, second, third])
        expect(getVault).toHaveBeenCalledTimes(2)
        expect(heard).toHaveBeenCalledTimes(1)
    })

    it("gives another account nothing of the last one's, and takes its settings as they are", async () => {
        const first = await accountWithVault('account-1')
        const second = await accountWithVault('account-2')
        let signedIn = first.target
        const shared = device(() => signedIn)
        shared.settings.set(KEY, 'pk.first-person')
        await shared.sync.sync()

        signedIn = second.target
        await shared.sync.sync()
        expect(shared.settings.get(KEY)).toBeUndefined()
        expect(await second.vaultSettings()).toBeUndefined()
    })
})
