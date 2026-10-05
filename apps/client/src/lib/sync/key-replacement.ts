/**
 * Key Replacement (ADR 0128): a new Recovery Code, a new vault key and a new Sync Identity for the
 * account on one Sync Server, written with everything that stops an old copy of the keys being
 * used. It is for keys that may have been copied: a Recovery Code someone else saw, or a device
 * the user no longer trusts. Regenerate is for a code that was only lost, and keeps the vault key.
 *
 * Prepared first, so the new code is on screen before anything changes, as with Regenerate, and
 * committed only once the user confirms they saved it. The vault's contents carry over: every
 * Graph Key, pin and protection record. What the Sync Server did besides (invites declined and
 * withdrawn, graphs made due a new epoch, a new access token) comes back for the caller to act on
 * and tell the user.
 */
import { keyReplaceTranscript } from '@appsoftwareltd/etherpk-shared'
import {
    type KeyVault,
    deriveVaultWrapKey,
    encryptVault,
    fingerprint,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    generateSigningKeyPair,
    identityHash,
    identityPublicKeys,
    openVault,
    sha256,
    signMessage,
    toBase64Url,
} from '$lib/crypto'
import { collectKeyHandouts } from './key-handouts'
import { NoVaultError } from './recovery-unlock'
import type { KeyReplaceResponse, SyncApi } from './sync-api'
import { isVersionConflict, updateVault } from './vault-update'

type ReplacementApi = Pick<SyncApi, 'getVault' | 'putKeys' | 'listKeyHandouts' | 'acknowledgeKeyHandout' | 'replaceKeys'>

export interface KeyReplacementResult extends Omit<KeyReplaceResponse, 'version'> {
    /** The new vault key, for this device to cache. Every other device must unlock again. */
    vaultKey: Uint8Array
    /** The account's new Security Fingerprint, which the people it shares graphs with will see. */
    fingerprint: string
}

export interface PreparedKeyReplacement {
    /** Show this once. Nothing changes until `commit`: the current code and keys work until then. */
    code: string
    /** Replace the keys. Runs only once the user has confirmed they saved `code`. */
    commit(): Promise<KeyReplacementResult>
    /**
     * After `commit` threw: did the replacement land anyway? A request can time out after the
     * server committed it. Resolves to the new vault key when the vault on the server now opens
     * under the new code, null when it does not. Rejects when the server cannot be reached.
     */
    activeVaultKey(): Promise<Uint8Array | null>
}

/** How many times the replacement is made again on the newer vault after another device's write. */
const MAX_ATTEMPTS = 3

/**
 * Prepare a Key Replacement for the account `api` reaches, with `heldKey`, what this device holds
 * for its vault. Writes nothing.
 */
export async function prepareKeyReplacement(api: ReplacementApi, heldKey: Uint8Array): Promise<PreparedKeyReplacement> {
    const existing = await api.getVault()
    if (!existing) throw new NoVaultError()
    // Opened now, so a held key that cannot open the vault fails before any code is shown.
    await openVault(fromBase64Url(existing.vault), heldKey)
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)
    const identity = generateIdentityKeyPair()
    const signing = generateSigningKeyPair()

    return {
        code,
        async commit() {
            // Copies of graph keys waiting for this account are sealed to the identity being
            // replaced: take them in while this device can still open them.
            await collectKeyHandouts(api, heldKey).catch(() => undefined)
            // A vault from before signing keys has nothing to sign the replacement with. An
            // ordinary write gives it its signing key first, and publishes it.
            await updateVault(api, heldKey, { apply: (vault) => (vault.signingPrivateKey ? null : vault) })

            for (let attempt = 1; ; attempt++) {
                const stored = await api.getVault()
                if (!stored) throw new NoVaultError()
                const opened = await openVault(fromBase64Url(stored.vault), heldKey)
                const next: KeyVault = {
                    ...opened.vault,
                    identityPrivateKey: identity.privateKey,
                    identityPublicKey: identity.publicKey,
                    signingPrivateKey: signing.privateKey,
                    signingPublicKey: signing.publicKey,
                }
                // No vault key passed, so a new one is made: the old one opens nothing from now on.
                const { envelope, vaultKey } = await encryptVault(next, wrapKey)
                const publicIdentity = identityPublicKeys(next)!
                const transcript = keyReplaceTranscript({
                    principalId: stored.principalId,
                    expectedVersion: stored.version,
                    vaultHash: await sha256(envelope),
                    identityHash: await identityHash(publicIdentity),
                })
                try {
                    const { version: _version, ...replaced } = await api.replaceKeys({
                        vault: toBase64Url(envelope),
                        expectedVersion: stored.version,
                        identity: {
                            publicKey: toBase64Url(publicIdentity.publicKey),
                            signingPublicKey: toBase64Url(publicIdentity.signingPublicKey),
                        },
                        // The key on record signs it, and the new key proves it is held.
                        signature: toBase64Url(signMessage(transcript, opened.vault.signingPrivateKey!)),
                        newSignature: toBase64Url(signMessage(transcript, signing.privateKey)),
                    })
                    return { ...replaced, vaultKey, fingerprint: await fingerprint(publicIdentity) }
                } catch (error) {
                    // Another device wrote the vault meanwhile: replace the newer one, keeping its change.
                    if (isVersionConflict(error) && attempt < MAX_ATTEMPTS) continue
                    throw error
                }
            }
        },
        async activeVaultKey() {
            const latest = await api.getVault()
            if (!latest) return null
            try {
                return (await openVault(fromBase64Url(latest.vault), wrapKey)).vaultKey
            } catch {
                return null
            }
        },
    }
}
