/**
 * Device-local vault unlock, partitioned by Sync Server origin and service-local Principal.
 * The scope prevents one signed-in account from reusing or observing another account's key, and
 * keeps each server's keys apart on a device connected to several (ADR 0111): every call names
 * the server whose keys it means, and the account confirmed there picks the partition. It is a
 * local privacy boundary only; the Server still authorises every remote operation.
 */
import { fromBase64Url, toBase64Url } from '$lib/crypto'
import { readSyncAccount } from './account-scope'
import { openVaultWithRecoveryCode } from './recovery-unlock'
import type { SyncApi } from './sync-api'

const LEGACY_KEY = 'etherpk:vault-wrap-key'

function scopedKey(serverOrigin: string): string | null {
    const account = readSyncAccount(serverOrigin)
    return account
        ? `${LEGACY_KEY}:${encodeURIComponent(account.serverOrigin)}:${encodeURIComponent(account.principalId)}`
        : null
}

function removeUnsafeLegacyKey(): void {
    // The old key carried no account identity. Assigning it to whichever account signs in
    // first would cross the new isolation boundary, so the safe migration is to re-lock once.
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_KEY)
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(LEGACY_KEY)
}

/** The vault wrap key of the account confirmed on `serverOrigin`, or null if its vault is locked here. */
export function getVaultWrapKey(serverOrigin: string): Uint8Array | null {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key || typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
        return fromBase64Url(raw)
    } catch {
        localStorage.removeItem(key)
        return null
    }
}

export function isVaultUnlocked(serverOrigin: string): boolean {
    return getVaultWrapKey(serverOrigin) !== null
}

/** Cache a wrap key only after `/sync/me` has confirmed the account on `serverOrigin`. */
export function setVaultWrapKey(serverOrigin: string, wrapKey: Uint8Array): void {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (!key) throw new Error('Authenticate with the Sync Server before unlocking keys')
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, toBase64Url(wrapKey))
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
    const held: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(`${LEGACY_KEY}:`)) held.push(key)
    }
    for (const key of held) localStorage.removeItem(key)
}

/** Lock the account on `serverOrigin` without touching keys cached for any other account or server. */
export function lockVault(serverOrigin: string): void {
    removeUnsafeLegacyKey()
    const key = scopedKey(serverOrigin)
    if (key && typeof localStorage !== 'undefined') localStorage.removeItem(key)
}

export class VaultLockedError extends Error {
    constructor() {
        super('Vault is locked')
        this.name = 'VaultLockedError'
    }
}
