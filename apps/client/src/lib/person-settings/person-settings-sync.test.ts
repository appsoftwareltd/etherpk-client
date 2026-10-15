import { describe, expect, it, vi } from 'vitest'

import { openSettingsVault, openVault, randomBytes, sealSettingsVault } from '$lib/crypto'
import { createFakeSyncServer, seedAccount } from '$lib/sync/testing/fake-sync-server'
import { updateVault } from '$lib/sync/vault-update'

import { createPersonSettings, extensionSettingKey } from './person-settings'
import { createPersonSettingsSync, type PersonSettingsAccount } from './person-settings-sync'

// The person's settings travel in their account's Settings Vault (ADR 0134, ADR 0148), so they
// follow the person to every device where the account syncs, and never in the Key Vault, which an
// agent the person signs in can read.

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
const OTHER = extensionSettingKey('kitchen', 'colour')

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
    /** The settings the account's Settings Vault holds now, or undefined while it has none. */
    const vaultSettings = async () => {
        const stored = server.accounts.get(principalId)!.settingsVault
        return stored ? (await openSettingsVault(stored.bytes, seeded.vaultKey)).settings : undefined
    }
    /** The settings the Key Vault holds now: only an earlier version put them there. */
    const keyVaultSettings = async () => {
        const stored = server.accounts.get(principalId)!.vault!
        return (await openVault(stored.bytes, seeded.vaultKey)).vault.settings
    }
    /** Put settings in the Key Vault, as a version before ADR 0148 kept them. */
    const keepInKeyVault = (settings: Record<string, { value: string | null; changedAt: number }>) =>
        updateVault(seeded.api, seeded.vaultKey, { apply: (vault) => ({ ...vault, settings: { ...vault.settings, ...settings } }) })
    return { server, seeded, target, vaultSettings, keyVaultSettings, keepInKeyVault }
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

    it('carries a setting from one device to another through the Settings Vault, never the Key Vault', async () => {
        const { target, vaultSettings, keyVaultSettings } = await accountWithVault()
        const laptop = device(() => target)
        const phone = device(() => target)
        expect(laptop.sync.state()).toBe('syncing')

        laptop.settings.set(KEY, 'pk.from-laptop')
        await laptop.sync.sync()
        expect(laptop.sync.state()).toBe('synced')
        expect(laptop.settings.hasPending()).toBe(false)
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.from-laptop', changedAt: 1_000 } })
        expect(await keyVaultSettings()).toBeUndefined()

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

    it('writes nothing when the Settings Vault has everything, and never writes the Key Vault for a setting', async () => {
        const { seeded, target } = await accountWithVault()
        const putKeys = vi.spyOn(seeded.api, 'putKeys')
        const putSettingsVault = vi.spyOn(seeded.api, 'putSettingsVault')
        const { settings, sync } = device(() => target)
        await sync.sync()
        expect(putSettingsVault).not.toHaveBeenCalled()

        settings.set(KEY, 'pk.one')
        await sync.sync()
        await sync.sync()
        expect(putSettingsVault).toHaveBeenCalledTimes(1)
        expect(putKeys).not.toHaveBeenCalled()
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

    it('waits, and writes nothing over the Settings Vault, when reading it fails', async () => {
        const { seeded, target, vaultSettings } = await accountWithVault()
        const laptop = device(() => target)
        laptop.settings.set(KEY, 'pk.kept')
        await laptop.sync.sync()

        const phone = device(() => target)
        vi.spyOn(seeded.api, 'getSettingsVault').mockRejectedValueOnce(new TypeError('Failed to fetch'))
        await phone.sync.sync()

        expect(phone.sync.state()).toBe('waiting')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.kept', changedAt: 1_000 } })
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

    it('applies a write another device made first, rather than overwriting it', async () => {
        const { server, target, vaultSettings } = await accountWithVault()
        const laptop = device(() => target)
        laptop.settings.set(KEY, 'pk.laptop')
        await laptop.sync.sync()

        // The phone reads before the laptop's write lands, so its own write meets a newer version.
        const phoneApi = server.apiFor('account-1')
        vi.spyOn(phoneApi, 'getSettingsVault').mockResolvedValueOnce(null)
        const phone = device(() => ({ ...target, api: phoneApi }))
        phone.settings.set(OTHER, 'green')
        await phone.sync.sync()

        expect(phone.sync.state()).toBe('synced')
        expect(phone.settings.get(KEY)).toBe('pk.laptop')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.laptop', changedAt: 1_000 }, [OTHER]: { value: 'green', changedAt: 1_000 } })
    })
})

describe('the Settings Vault, written again from the device (ADR 0148)', () => {
    it('after a Key Replacement drops it, holds everything the device has, not only what changed here', async () => {
        const { server, target, vaultSettings } = await accountWithVault()
        const { settings, sync } = device(() => target)
        settings.set(KEY, 'pk.one')
        settings.set(OTHER, 'green')
        await sync.sync()
        server.accounts.get('account-1')!.settingsVault = null

        await sync.sync()

        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.one', changedAt: 1_000 }, [OTHER]: { value: 'green', changedAt: 1_000 } })
    })

    it('when this device cannot open it, is written again from the device', async () => {
        const { server, target, vaultSettings } = await accountWithVault()
        const { settings, sync } = device(() => target)
        settings.set(KEY, 'pk.one')
        await sync.sync()
        // Sealed under a key this device does not hold, as a vault key that has since changed would be.
        server.accounts.get('account-1')!.settingsVault = { bytes: await sealSettingsVault({ settings: {} }, randomBytes(32)), version: 4 }

        await sync.sync()

        expect(sync.state()).toBe('synced')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.one', changedAt: 1_000 } })
    })
})

describe('settings an earlier version kept in the Key Vault (ADR 0148)', () => {
    it('move into the Settings Vault, then leave the Key Vault', async () => {
        const { target, vaultSettings, keyVaultSettings, keepInKeyVault } = await accountWithVault()
        await keepInKeyVault({ [KEY]: { value: 'pk.moved', changedAt: 500 } })
        const { settings, sync } = device(() => target)
        settings.set(OTHER, 'green')

        await sync.sync()

        expect(sync.state()).toBe('synced')
        expect(settings.get(KEY)).toBe('pk.moved')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.moved', changedAt: 500 }, [OTHER]: { value: 'green', changedAt: 1_000 } })
        expect(await keyVaultSettings()).toBeUndefined()
    })

    it('lose to a later change in the Settings Vault, and still leave the Key Vault', async () => {
        const { target, vaultSettings, keyVaultSettings, keepInKeyVault } = await accountWithVault()
        const laptop = device(() => target)
        laptop.at(2_000)
        laptop.settings.set(KEY, 'pk.newer')
        await laptop.sync.sync()
        await keepInKeyVault({ [KEY]: { value: 'pk.older', changedAt: 900 } })

        const phone = device(() => target)
        await phone.sync.sync()

        expect(phone.settings.get(KEY)).toBe('pk.newer')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.newer', changedAt: 2_000 } })
        expect(await keyVaultSettings()).toBeUndefined()
    })

    it('stay in the Key Vault when one changed there after they were moved, until the next sync moves it', async () => {
        const { seeded, target, vaultSettings, keyVaultSettings, keepInKeyVault } = await accountWithVault()
        await keepInKeyVault({ [KEY]: { value: 'pk.moved', changedAt: 500 } })
        // An earlier version, still open in another tab, changes the setting in the Key Vault just
        // as this device takes it out, so this device's write meets a newer Key Vault.
        const putKeys = seeded.api.putKeys
        let raced = false
        vi.spyOn(seeded.api, 'putKeys').mockImplementation(async (write) => {
            if (!raced) {
                raced = true
                await updateVault({ getVault: seeded.api.getVault, putKeys }, seeded.vaultKey, {
                    apply: (vault) => ({ ...vault, settings: { ...vault.settings, [KEY]: { value: 'pk.older-tab', changedAt: 9_000 } } }),
                })
            }
            return putKeys(write)
        })
        const { settings, sync } = device(() => target)

        await sync.sync()
        expect(await keyVaultSettings()).toEqual({ [KEY]: { value: 'pk.older-tab', changedAt: 9_000 } })

        await sync.sync()
        expect(settings.get(KEY)).toBe('pk.older-tab')
        expect(await vaultSettings()).toEqual({ [KEY]: { value: 'pk.older-tab', changedAt: 9_000 } })
        expect(await keyVaultSettings()).toBeUndefined()
    })
})
