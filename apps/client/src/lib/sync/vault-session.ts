/**
 * Device-local vault unlock, partitioned by Sync Server origin and service-local Principal.
 * The scope prevents one signed-in account from reusing or observing another account's key, and
 * keeps each server's keys apart on a device connected to several (ADR 0111): every call names
 * the server whose keys it means, and the account confirmed there picks the partition. It is a
 * local privacy boundary only; the Server still authorises every remote operation.
 *
 * With a Device Passcode set (ADR 0129) each cached key is stored sealed under it, and read from
 * the memory of a tab that has been unlocked (`device-passcode.ts`).
 *
 * Beside each key the device keeps a copy of the account's vault as the server last sent it, so a
 * synced graph opens when its server cannot be reached (`vault-copy.ts`). The copy is ciphertext
 * the cached key opens, kept in the same partition and removed with the key, so the two are held
 * or lost together. This module is the one place both are stored, which is what a platform with a
 * secure key store of its own would replace.
 */
import { fromBase64Url, toBase64Url } from '$lib/crypto'
import { readSyncAccount } from './account-scope'
import { DevicePasscodeLockedError, devicePasscode } from './device-passcode'
import { openVaultWithRecoveryCode } from './recovery-unlock'
import type { SyncApi } from './sync-api'
import { UnlockCancelledError, VaultLockedError } from './vault-locked'

const LEGACY_KEY = 'etherpk:vault-wrap-key'
/** Every account's cached key is stored under this prefix, scoped by server and account. */
const SCOPED_PREFIX = `${LEGACY_KEY}:`
/**
 * Every account's vault copy is stored under this prefix, in the same partition as its key. A
 * different prefix from the key's, so the Device Passcode, which seals every entry under that
 * one, leaves the copy as it is: it is ciphertext already, and the key it needs is what is sealed.
 */
const COPY_PREFIX = 'etherpk:vault-copy:'

/** The partition of the account confirmed on `serverOrigin`, or null when none is. */
function accountPartition(serverOrigin: string): { name: string; principalId: string } | null {
    const account = readSyncAccount(serverOrigin)
    return account
        ? { name: `${encodeURIComponent(account.serverOrigin)}:${encodeURIComponent(account.principalId)}`, principalId: account.principalId }
        : null
}

function scopedKey(serverOrigin: string): string | null {
    const partition = accountPartition(serverOrigin)
    return partition ? `${SCOPED_PREFIX}${partition.name}` : null
}

/** The storage keys under `prefix`: every account's cached vault key, or every vault copy. */
function storedNames(prefix: string): string[] {
    if (typeof localStorage === 'undefined') return []
    const held: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(prefix)) held.push(key)
    }
    return held
}

/** The storage keys of every account's cached vault key. */
function heldKeyNames(): string[] {
    return storedNames(SCOPED_PREFIX)
}

// The cached vault keys are secrets the Device Passcode seals, opens and removes as a set.
devicePasscode.registerStore({
    entries: () =>
        heldKeyNames()
            .map((id) => ({ id, stored: localStorage.getItem(id) ?? '' }))
            .filter((entry) => entry.stored !== ''),
    write: (id, stored) => localStorage.setItem(id, stored),
    remove: (id) => localStorage.removeItem(id),
})

function removeUnsafeLegacyKey(): void {
    // The old key carried no account identity. Assigning it to whichever account signs in
    // first would cross the new isolation boundary, so the safe migration is to re-lock once.
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_KEY)
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(LEGACY_KEY)
}

/**
 * The vault wrap key of the account confirmed on `serverOrigin`, or null if its vault is locked
 * here: never unlocked on this device, or sealed by a Device Passcode not yet entered.
 */
export function getVaultWrapKey(serverOrigin: string): Uint8Array | null {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key || typeof localStorage === 'undefined') return null
    const raw = devicePasscode.reveal(key, localStorage.getItem(key))
    if (!raw) return null
    try {
        return fromBase64Url(raw)
    } catch {
        localStorage.removeItem(key)
        devicePasscode.forget(key)
        return null
    }
}

export function isVaultUnlocked(serverOrigin: string): boolean {
    return getVaultWrapKey(serverOrigin) !== null
}

/**
 * The vault wrap key of the account on `serverOrigin`, or the reason there is none to read: a
 * {@link DevicePasscodeLockedError} when it is held sealed and this tab has not been unlocked, so the
 * prompt asks for the passcode, else a {@link VaultLockedError}, for the Recovery Code or approval.
 */
export function requireVaultWrapKey(serverOrigin: string): Uint8Array {
    const held = getVaultWrapKey(serverOrigin)
    if (held) return held
    const key = scopedKey(serverOrigin)
    const stored = key && typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    // Sealed but unreadable in an unlocked tab is a key gone bad, which only the account can replace.
    throw devicePasscode.isSealed(stored) && devicePasscode.state() === 'locked'
        ? new DevicePasscodeLockedError()
        : new VaultLockedError()
}

/**
 * Cache a wrap key only after `/sync/me` has confirmed the account on `serverOrigin`. With a
 * Device Passcode set it is stored sealed, a moment later: reads in this tab see it at once.
 */
export function setVaultWrapKey(serverOrigin: string, wrapKey: Uint8Array): void {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key) throw new Error('Authenticate with the Sync Server before unlocking Encryption Keys')
    if (typeof localStorage === 'undefined') return
    void devicePasscode
        .store(key, toBase64Url(wrapKey), (stored) => localStorage.setItem(key, stored))
        .catch((error: unknown) => console.warn('[keys] could not store the vault key on this device', error))
}

/**
 * Unlock with a Recovery Code, caching the vault key only once the code has opened the vault of
 * the account on `serverOrigin` (recovery-unlock.ts). A wrong code - including one for another
 * server's account - throws `RecoveryCodeError` and caches nothing.
 */
export async function unlockWithRecoveryCode(
    api: Pick<SyncApi, 'getVault'>,
    code: string,
    serverOrigin: string,
): Promise<Uint8Array> {
    const vaultKey = await openVaultWithRecoveryCode(api, code)
    setVaultWrapKey(serverOrigin, vaultKey)
    return vaultKey
}

/**
 * Lock every account whose keys this browser holds, on every server: removing this browser's
 * synced graphs, on a machine someone else will use, leaves no account's keys behind.
 */
export function lockEveryVault(): void {
    removeUnsafeLegacyKey()
    if (typeof localStorage === 'undefined') return
    for (const key of heldKeyNames()) {
        localStorage.removeItem(key)
        // Every tab drops it from memory too, where a Device Passcode keeps it.
        devicePasscode.forget(key)
    }
    for (const copy of storedNames(COPY_PREFIX)) localStorage.removeItem(copy)
}

/** Lock the account on `serverOrigin` without touching keys cached for any other account or server. */
export function lockVault(serverOrigin: string): void {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key || typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
    devicePasscode.forget(key)
    forgetVaultCopy(serverOrigin)
}

/** The account's vault as its Sync Server last sent it: the sealed blob, its version and its account. */
export interface VaultCopy {
    vault: string
    version: number
    principalId: string
}

function copyName(serverOrigin: string): { name: string; principalId: string } | null {
    const partition = accountPartition(serverOrigin)
    return partition ? { name: `${COPY_PREFIX}${partition.name}`, principalId: partition.principalId } : null
}

/**
 * Keep `copy` as the vault of the account confirmed on `serverOrigin`, replacing any older one. A
 * vault that names another account is not kept: the server answered for someone else.
 */
export function keepVaultCopy(serverOrigin: string, copy: VaultCopy): void {
    const target = copyName(serverOrigin)
    if (!target || target.principalId !== copy.principalId || typeof localStorage === 'undefined') return
    try {
        localStorage.setItem(target.name, JSON.stringify({ vault: copy.vault, version: copy.version, principalId: copy.principalId }))
    } catch (error) {
        // A full storage quota: the copy is only for opening offline, and the server still has the vault.
        console.warn('[keys] could not keep a copy of the vault on this device', error)
    }
}

/** The vault copy of the account confirmed on `serverOrigin`, or null when none is kept or it is damaged. */
export function readVaultCopy(serverOrigin: string): VaultCopy | null {
    const target = copyName(serverOrigin)
    if (!target || typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(target.name)
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw) as Partial<VaultCopy>
        if (typeof parsed.vault !== 'string' || typeof parsed.version !== 'number' || parsed.principalId !== target.principalId) return null
        return { vault: parsed.vault, version: parsed.version, principalId: parsed.principalId }
    } catch {
        return null
    }
}

/** Remove the vault copy of the account confirmed on `serverOrigin`, as when the account has no vault. */
export function forgetVaultCopy(serverOrigin: string): void {
    const target = copyName(serverOrigin)
    if (target && typeof localStorage !== 'undefined') localStorage.removeItem(target.name)
}

export { UnlockCancelledError, VaultLockedError }
