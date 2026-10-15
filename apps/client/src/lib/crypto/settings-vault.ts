/**
 * The Settings Vault (ADR 0148): the person's settings (ADR 0134), sealed under the account's
 * vault key, the same key that seals the Key Vault's content. The Sync Server keeps the two apart
 * and gives this one to no agent token, so the API keys among the person's settings never reach an
 * agent the person signs in, which holds the vault key but can only fetch the Key Vault.
 *
 * One symmetric envelope, with its own context so it can never be opened as the Key Vault's
 * content, or the Key Vault's content as it. The content is JSON: `settings`, and any top-level
 * field a later version adds, kept and written back unchanged as the Key Vault keeps its own.
 */
import { utf8 } from './bytes'
import { contextAad, openSymmetric, sealSymmetric } from './envelope'
import type { VaultSetting } from './vault'

export interface SettingsVault {
    /** The person's settings by key, as person-settings.ts keeps them. */
    settings: Record<string, VaultSetting>
    /** Top-level fields this version does not know, written back unchanged. */
    otherFields?: Record<string, unknown>
}

const SETTINGS_VAULT_AAD = contextAad('settings-vault', 'v1')

export async function sealSettingsVault(vault: SettingsVault, vaultKey: Uint8Array): Promise<Uint8Array> {
    // Known fields are written last, so an unknown field can never shadow one.
    const content = { ...vault.otherFields, settings: vault.settings }
    return sealSymmetric({ key: vaultKey, epochId: 0, plaintext: utf8(JSON.stringify(content)), aad: SETTINGS_VAULT_AAD })
}

/** @throws EnvelopeError when `vaultKey` is not the key it was sealed under. */
export async function openSettingsVault(envelope: Uint8Array, vaultKey: Uint8Array): Promise<SettingsVault> {
    const { plaintext } = await openSymmetric({ keyForEpoch: () => vaultKey, envelope, aad: SETTINGS_VAULT_AAD })
    const { settings, ...otherFields } = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
    return {
        // Read as settings by person-settings.ts, which drops anything that does not read as one.
        settings: typeof settings === 'object' && settings !== null ? (settings as Record<string, VaultSetting>) : {},
        ...(Object.keys(otherFields).length > 0 ? { otherFields } : {}),
    }
}
