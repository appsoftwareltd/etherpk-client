/**
 * Device-local vault unlock, partitioned by Sync Server origin and service-local Principal.
 * The scope prevents one signed-in account from reusing or observing another account's key.
 * It is a local privacy boundary only; the Server still authorises every remote operation.
 */
import { deriveVaultWrapKey, fromBase64Url, toBase64Url } from '$lib/crypto'
import { readActiveSyncAccount } from './account-scope'

const LEGACY_KEY = 'etherpk:vault-wrap-key'

function scopedKey(): string | null {
    const account = readActiveSyncAccount()
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

/** The active account's unlocked vault wrap key, or null if its vault is locked. */
export function getVaultWrapKey(): Uint8Array | null {
    removeUnsafeLegacyKey()
    const key = scopedKey()
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

export function isVaultUnlocked(): boolean {
    return getVaultWrapKey() !== null
}

/** Cache a wrap key only after `/sync/me` has established the active local partition. */
export function setVaultWrapKey(wrapKey: Uint8Array): void {
    removeUnsafeLegacyKey()
    const key = scopedKey()
    if (!key) throw new Error('Authenticate with the Sync Server before unlocking keys')
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, toBase64Url(wrapKey))
}

export async function unlockWithRecoveryCode(code: string): Promise<Uint8Array> {
    const wrapKey = await deriveVaultWrapKey(code)
    setVaultWrapKey(wrapKey)
    return wrapKey
}

/** Lock the active account without destroying keys cached for a different account. */
export function lockVault(): void {
    removeUnsafeLegacyKey()
    const key = scopedKey()
    if (key && typeof localStorage !== 'undefined') localStorage.removeItem(key)
}

export class VaultLockedError extends Error {
    constructor() {
        super('Vault is locked')
        this.name = 'VaultLockedError'
    }
}
