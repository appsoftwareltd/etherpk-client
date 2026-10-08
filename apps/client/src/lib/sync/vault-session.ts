/**
 * Device-local vault unlock, partitioned by Sync Server origin and service-local Principal.
 * The scope prevents one signed-in account from reusing or observing another account's key, and
 * keeps each server's keys apart on a device connected to several (ADR 0111): every call names
 * the server whose keys it means, and the account confirmed there picks the partition. It is a
 * local privacy boundary only; the Server still authorises every remote operation.
 *
 * With a Device Passcode set (ADR 0129) each cached key is stored sealed under it, and read from
 * the memory of a tab that has been unlocked (`device-passcode.ts`).
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

function scopedKey(serverOrigin: string): string | null {
    const account = readSyncAccount(serverOrigin)
    return account
        ? `${SCOPED_PREFIX}${encodeURIComponent(account.serverOrigin)}:${encodeURIComponent(account.principalId)}`
        : null
}

/** The storage keys of every account's cached vault key. */
function heldKeyNames(): string[] {
    if (typeof localStorage === 'undefined') return []
    const held: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(SCOPED_PREFIX)) held.push(key)
    }
    return held
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
}

/** Lock the account on `serverOrigin` without touching keys cached for any other account or server. */
export function lockVault(serverOrigin: string): void {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key || typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
    devicePasscode.forget(key)
}

export { UnlockCancelledError, VaultLockedError }
