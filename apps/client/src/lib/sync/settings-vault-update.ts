/**
 * Every write of an account's Settings Vault (ADR 0148), signed by the account's signing key.
 *
 * A write is a read, a change and a write, as a Key Vault write is (`vault-update.ts`): read the
 * Settings Vault, open it with the vault key, apply the change to what was read, then seal, sign
 * and write it against the version read. When another device wrote in between, the server answers
 * 409 and the change is applied again to the newer Settings Vault.
 */
import { settingsVaultWriteTranscript } from '@appsoftwareltd/etherpk-shared'
import { type SettingsVault, fromBase64Url, openSettingsVault, sealSettingsVault, sha256, signMessage, toBase64Url } from '$lib/crypto'
import type { SyncApi } from './sync-api'
import { isVersionConflict } from './vault-update'

/** How many times a change is applied to a newer Settings Vault after other devices' writes before giving up. */
const MAX_ATTEMPTS = 3

/** What a Settings Vault write needs from the account's Key Vault. */
export interface SettingsVaultKeys {
    /** The account the Settings Vault belongs to. The signature names it. */
    principalId: string
    /** The key the Settings Vault is sealed under: the one that seals the Key Vault's content. */
    vaultKey: Uint8Array
    /** The account's Ed25519 signing key, which the server checks every write against. */
    signingPrivateKey: Uint8Array
}

export interface SettingsVaultChange {
    /**
     * The new content, worked out from the Settings Vault as the server holds it now, or null to
     * write nothing. `current` is null when the account has none, or has one this vault key does
     * not open: a vault key replaced since it was written. Either way the change writes it again
     * from scratch. It runs again after another device's write, so it must work only from what it
     * is given.
     */
    apply(current: SettingsVault | null): SettingsVault | null
}

/**
 * Read the Settings Vault, apply `change` and write the result, signed, applying it again to the
 * newer one when another device wrote first. Resolves to the content the server now holds: what
 * was written, or what was read when nothing was.
 */
export async function updateSettingsVault(
    api: Pick<SyncApi, 'getSettingsVault' | 'putSettingsVault'>,
    keys: SettingsVaultKeys,
    change: SettingsVaultChange,
): Promise<SettingsVault | null> {
    for (let attempt = 1; ; attempt++) {
        // A failed read rejects here, before anything is written over what the server holds.
        const stored = await api.getSettingsVault()
        let current: SettingsVault | null = null
        if (stored) {
            try {
                current = await openSettingsVault(fromBase64Url(stored.vault), keys.vaultKey)
            } catch {
                // Sealed under a vault key the account no longer has: nothing can open it, so the
                // change writes it again from what this device holds.
                current = null
            }
        }
        const next = change.apply(current)
        if (!next) return current
        const envelope = await sealSettingsVault(next, keys.vaultKey)
        const expectedVersion = stored?.version ?? 0
        const transcript = settingsVaultWriteTranscript({ principalId: keys.principalId, expectedVersion, settingsVaultHash: await sha256(envelope) })
        try {
            await api.putSettingsVault({ vault: toBase64Url(envelope), expectedVersion, signature: toBase64Url(signMessage(transcript, keys.signingPrivateKey)) })
            return next
        } catch (error) {
            if (isVersionConflict(error) && attempt < MAX_ATTEMPTS) continue
            throw error
        }
    }
}
