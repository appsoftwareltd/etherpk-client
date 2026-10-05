import { describe, expect, it } from 'vitest'
import { sha256, toBase64Url, utf8, type ProtectionKdfParams } from '$lib/crypto'
import {
    DEVICE_PASSCODE_RECORD_KEY,
    DevicePasscodeLockedError,
    WrongDevicePasscodeError,
    createDevicePasscode,
    type DeviceSecretStore,
} from './device-passcode'
import { VaultLockedError } from './vault-locked'

function memoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() {
            return store.size
        },
    }
}

/** A BroadcastChannel stand-in: every other channel made by this bus hears each message. */
function bus() {
    const channels = new Set<{ onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void }>()
    return () => {
        const channel = {
            onmessage: null as ((event: { data: unknown }) => void) | null,
            postMessage(data: unknown) {
                for (const other of channels) if (other !== channel) queueMicrotask(() => other.onmessage?.({ data }))
            },
        }
        channels.add(channel)
        return channel
    }
}

/** Secrets kept under `prefix` in `storage`, as the vault key store keeps them. */
function prefixedStore(storage: Storage, prefix = 'secret:'): DeviceSecretStore {
    return {
        entries: () =>
            [...Array(storage.length)]
                .map((_, index) => storage.key(index)!)
                .filter((key) => key.startsWith(prefix))
                .map((id) => ({ id, stored: storage.getItem(id)! })),
        write: (id, stored) => storage.setItem(id, stored),
        remove: (id) => storage.removeItem(id),
    }
}

// Argon2id is slow on purpose; these tests check what the passcode protects, not how it is stretched.
const quickStretch = async (passcode: string, kdf: ProtectionKdfParams) => sha256(utf8(`${passcode}|${kdf.salt}`))

/** A tab of the same origin: its own memory, the storage and channels every tab shares. */
function tab(storage: Storage, channel: ReturnType<typeof bus>) {
    const passcode = createDevicePasscode({ storage: () => storage, channel, stretch: quickStretch, answerWithinMs: 50 })
    passcode.registerStore(prefixedStore(storage))
    return passcode
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the Device Passcode (ADR 0129)', () => {
    it('is off until set, and stores secrets as they are', async () => {
        const storage = memoryStorage()
        const device = tab(storage, bus())

        await device.store('secret:a', 'alpha', (stored) => storage.setItem('secret:a', stored))

        expect(device.state()).toBe('off')
        expect(storage.getItem('secret:a')).toBe('alpha')
        expect(device.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
    })

    it('seals every stored secret once set, leaving no plain copy, and keeps them readable here', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        storage.setItem('secret:b', 'beta')
        storage.setItem('other', 'untouched')
        const device = tab(storage, bus())

        await device.set('1234')

        expect(device.state()).toBe('unlocked')
        expect(storage.getItem('secret:a')).toMatch(/^pc1:/)
        expect(storage.getItem('secret:b')).toMatch(/^pc1:/)
        expect(storage.getItem('other')).toBe('untouched')
        expect(JSON.stringify(Object.fromEntries([...Array(storage.length)].map((_, i) => [storage.key(i), storage.getItem(storage.key(i)!)])))).not.toContain('alpha')
        expect(device.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
        expect(storage.getItem(DEVICE_PASSCODE_RECORD_KEY)).not.toBeNull()
    })

    it('refuses a passcode shorter than four characters', async () => {
        const device = tab(memoryStorage(), bus())

        await expect(device.set('123')).rejects.toBeInstanceOf(RangeError)
        expect(device.state()).toBe('off')
    })

    it('reveals nothing while locked, and opens every secret with the passcode', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        await tab(storage, bus()).set('1234')
        // The next page load: the same storage, nothing in memory.
        const reloaded = tab(storage, bus())

        expect(reloaded.state()).toBe('locked')
        expect(reloaded.reveal('secret:a', storage.getItem('secret:a'))).toBeNull()
        await reloaded.unlock('1234')

        expect(reloaded.state()).toBe('unlocked')
        expect(reloaded.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
    })

    it('refuses a wrong passcode and stays locked', async () => {
        const storage = memoryStorage()
        await tab(storage, bus()).set('1234')
        const reloaded = tab(storage, bus())

        await expect(reloaded.unlock('4321')).rejects.toBeInstanceOf(WrongDevicePasscodeError)
        expect(reloaded.state()).toBe('locked')
    })

    it('holds a secret written while locked in memory, and stores it sealed at the next unlock', async () => {
        const storage = memoryStorage()
        await tab(storage, bus()).set('1234')
        const reloaded = tab(storage, bus())

        await reloaded.store('secret:new', 'gamma', (stored) => storage.setItem('secret:new', stored))

        expect(storage.getItem('secret:new')).toBeNull()
        expect(reloaded.reveal('secret:new', null)).toBe('gamma')
        await reloaded.unlock('1234')
        expect(storage.getItem('secret:new')).toMatch(/^pc1:/)
        expect(reloaded.reveal('secret:new', storage.getItem('secret:new'))).toBe('gamma')
    })

    it('changes the passcode only with the current one, and re-seals every secret under the new one', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const device = tab(storage, bus())
        await device.set('1234')

        await expect(device.change('0000', 'abcdefgh')).rejects.toBeInstanceOf(WrongDevicePasscodeError)
        await device.change('1234', 'abcdefgh')

        const reloaded = tab(storage, bus())
        await expect(reloaded.unlock('1234')).rejects.toBeInstanceOf(WrongDevicePasscodeError)
        await reloaded.unlock('abcdefgh')
        expect(reloaded.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
    })

    it('turns off only with the current passcode, storing every secret as it is again', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const device = tab(storage, bus())
        await device.set('1234')

        await expect(device.turnOff('0000')).rejects.toBeInstanceOf(WrongDevicePasscodeError)
        await device.turnOff('1234')

        expect(device.state()).toBe('off')
        expect(storage.getItem('secret:a')).toBe('alpha')
        expect(storage.getItem(DEVICE_PASSCODE_RECORD_KEY)).toBeNull()
    })

    it('forgetting the passcode removes every sealed secret with it, and nothing else', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        storage.setItem('other', 'untouched')
        await tab(storage, bus()).set('1234')
        const reloaded = tab(storage, bus())

        reloaded.forgotten()

        expect(reloaded.state()).toBe('off')
        expect(storage.getItem('secret:a')).toBeNull()
        expect(storage.getItem('other')).toBe('untouched')
        expect(storage.getItem(DEVICE_PASSCODE_RECORD_KEY)).toBeNull()
    })

    it('hands a new tab the key from an open tab, so only the first tab asks', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const channels = bus()
        const first = tab(storage, channels)
        await first.set('1234')
        const second = tab(storage, channels)

        await expect(second.unlockFromOtherTabs()).resolves.toBe(true)

        expect(second.state()).toBe('unlocked')
        expect(second.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
    })

    it('stays locked after the wait when no open tab answers', async () => {
        const storage = memoryStorage()
        await tab(storage, bus()).set('1234')
        const alone = tab(storage, bus())

        await expect(alone.unlockFromOtherTabs()).resolves.toBe(false)
        expect(alone.state()).toBe('locked')
    })

    it('does not take a key from another tab that does not open this device’s record', async () => {
        const storage = memoryStorage()
        await tab(storage, bus()).set('1234')
        const channels = bus()
        const impostor = createDevicePasscode({ storage: () => memoryStorage(), channel: channels, stretch: quickStretch, answerWithinMs: 50 })
        await impostor.set('9999')
        // Only the impostor, whose key opens another record, is left to answer.
        const victim = createDevicePasscode({ storage: () => storage, channel: channels, stretch: quickStretch, answerWithinMs: 50 })

        await expect(victim.unlockFromOtherTabs()).resolves.toBe(false)
        expect(victim.state()).toBe('locked')
    })

    it('locks every tab when one locks', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const channels = bus()
        const first = tab(storage, channels)
        await first.set('1234')
        const second = tab(storage, channels)
        await second.unlockFromOtherTabs()

        first.lock()
        await settle()

        expect(second.state()).toBe('locked')
        expect(second.reveal('secret:a', storage.getItem('secret:a'))).toBeNull()
    })

    it('drops a forgotten secret from every tab’s memory', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const channels = bus()
        const first = tab(storage, channels)
        await first.set('1234')
        const second = tab(storage, channels)
        await second.unlockFromOtherTabs()

        storage.removeItem('secret:a')
        first.forget('secret:a')
        await settle()

        expect(second.reveal('secret:a', null)).toBeNull()
    })

    it('tells another tab of a secret written here, so it reads the new one at once', async () => {
        const storage = memoryStorage()
        const channels = bus()
        const first = tab(storage, channels)
        await first.set('1234')
        const second = tab(storage, channels)
        await second.unlockFromOtherTabs()

        await first.store('secret:a', 'fresh', (stored) => storage.setItem('secret:a', stored))
        await settle()

        expect(second.reveal('secret:a', storage.getItem('secret:a'))).toBe('fresh')
    })

    it('is a locked vault to code that only knows about vaults', () => {
        expect(new DevicePasscodeLockedError()).toBeInstanceOf(VaultLockedError)
    })

    it('stretches the passcode with Argon2id when given no other stretch', async () => {
        const storage = memoryStorage()
        storage.setItem('secret:a', 'alpha')
        const device = createDevicePasscode({ storage: () => storage, channel: () => null })
        device.registerStore(prefixedStore(storage))
        await device.set('slow passcode')

        const reloaded = createDevicePasscode({ storage: () => storage, channel: () => null })
        reloaded.registerStore(prefixedStore(storage))
        await reloaded.unlock('slow passcode')

        expect(reloaded.reveal('secret:a', storage.getItem('secret:a'))).toBe('alpha')
        expect(toBase64Url(utf8('alpha'))).not.toBe(storage.getItem('secret:a'))
    }, 30_000)
})
