import { describe, expect, it } from 'vitest'
import { randomBytes, utf8 } from './bytes'
import { EnvelopeError, contextAad, sealSymmetric } from './envelope'
import { openSettingsVault, sealSettingsVault } from './settings-vault'

const settings = {
    'extension.kitchen.key': { value: 'beans', changedAt: 10 },
    'extension.kitchen.colour': { value: null, changedAt: 20 },
}

describe('settings vault (ADR 0148)', () => {
    it('round-trips the settings under the vault key', async () => {
        const vaultKey = randomBytes(32)

        const opened = await openSettingsVault(await sealSettingsVault({ settings }, vaultKey), vaultKey)

        expect(opened.settings).toEqual(settings)
    })

    it('keeps a top-level field this version does not know, so a later version loses nothing', async () => {
        const vaultKey = randomBytes(32)
        const later = await sealSymmetric({
            key: vaultKey,
            epochId: 0,
            plaintext: utf8(JSON.stringify({ settings, garden: { rows: 3 } })),
            aad: contextAad('settings-vault', 'v1'),
        })

        const opened = await openSettingsVault(later, vaultKey)
        const again = await openSettingsVault(await sealSettingsVault(opened, vaultKey), vaultKey)

        expect(again).toEqual({ settings, otherFields: { garden: { rows: 3 } } })
    })

    it('opens with no other key', async () => {
        const envelope = await sealSettingsVault({ settings }, randomBytes(32))

        await expect(openSettingsVault(envelope, randomBytes(32))).rejects.toThrow(EnvelopeError)
    })

    it('is never taken for Key Vault content sealed under the same key, nor the other way round', async () => {
        const vaultKey = randomBytes(32)
        const keyVaultContent = await sealSymmetric({ key: vaultKey, epochId: 0, plaintext: utf8(JSON.stringify({ settings })), aad: contextAad('vault', 'v3') })

        await expect(openSettingsVault(keyVaultContent, vaultKey)).rejects.toThrow(EnvelopeError)
    })
})
