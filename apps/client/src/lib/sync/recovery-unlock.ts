/**
 * Unlock with a Recovery Code, checked against the account's vault.
 *
 * A Recovery Code derives the vault's wrap key, and any well-formed code derives *a* key. Caching
 * whatever came out would report a mistyped or retired code as success, and every graph would
 * then fail to open with a message that blamed the keys on the device, next to the control that
 * resets them. The browser and the Headless Client both use this one check: fetch the vault,
 * open it with the derived key, and hand back the vault key only once it has opened.
 *
 * What is returned is the vault key, never the wrap key, as Device Approval caches: it keeps
 * working after the Recovery Code is regenerated on another device.
 */
import { deriveVaultWrapKey, EnvelopeError, fromBase64Url, openVault, RecoveryCodeError } from '$lib/crypto'
import type { SyncApi } from './sync-api'

/** The account has no vault yet, so there is nothing for a Recovery Code to open. */
export class NoVaultError extends Error {
    constructor() {
        super('This account has no encryption keys yet; there is nothing for a Recovery Code to open.')
        this.name = 'NoVaultError'
    }
}

/**
 * @throws RecoveryCodeError when the code is malformed or does not open this account's vault.
 * @throws NoVaultError when the account has no vault.
 * Anything else (the vault could not be fetched) propagates unchanged: it says nothing about the code.
 */
export async function openVaultWithRecoveryCode(api: Pick<SyncApi, 'getVault'>, code: string): Promise<Uint8Array> {
    const wrapKey = await deriveVaultWrapKey(code)
    const stored = await api.getVault()
    if (!stored) throw new NoVaultError()
    try {
        return (await openVault(fromBase64Url(stored.vault), wrapKey)).vaultKey
    } catch (error) {
        // The derived key does not open the vault: a mistyped, retired or other account's code.
        if (error instanceof EnvelopeError) throw new RecoveryCodeError('That Recovery Code does not open this account’s keys. Check it character by character; only the most recently issued code works.')
        throw error
    }
}
