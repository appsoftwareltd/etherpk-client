/**
 * The account's own Sync Identity, checked each time its keys are used on a device (ADR 0126).
 *
 * Two things happen here. A vault written before signing keys existed gets its Ed25519 key pair,
 * and the identity is published with it, so the account can sign. Then the identity the Sync
 * Server publishes for the account is compared with the one in the vault. Anyone who could sign
 * in as the user, or the server itself, could once publish a key of their own there, and invites
 * would then have been sealed to them. When the two differ, the vault's identity is published
 * again with a signed write, and the caller warns the user.
 */
import { type KeyVault, bytesEqual, fingerprint, fromBase64Url, identityPublicKeys } from '$lib/crypto'
import { IDENTITY_PROOF_REFUSED_CODE, KEY_SIGNATURE_REFUSED_CODE } from '@appsoftwareltd/etherpk-shared'
import { SyncApiError, type PublishedIdentityJson, type SyncApi } from './sync-api'
import { updateVault } from './vault-update'

export interface AccountIdentityCheck {
    /** The vault as the server now holds it, with its signing key. */
    vault: KeyVault
    /** The key to cache on this device. */
    vaultKey: Uint8Array
    /**
     * The server was publishing an identity for this account that its vault does not hold, and now
     * publishes the vault's. The user must be told: invites sent to them in the meantime may have
     * been sealed to somebody else.
     */
    repaired: boolean
}

/**
 * The server publishes keys for this account that the vault does not hold, and refused to replace
 * them: a signing key that did not sign the write, or an X25519 key from before signing keys that
 * this device cannot prove it holds. Only someone with control of the server, or of the account
 * before signing keys existed, can have put them there, and only the server's operator can clear
 * them.
 */
export class ForeignIdentityError extends Error {
    constructor() {
        super('The Sync Server publishes a security key for this account that does not match your keys, and refused to replace it.')
        this.name = 'ForeignIdentityError'
    }
}

/**
 * Does the directory publish the identity this vault holds? A published identity without a
 * signing key and with the vault's X25519 key is the account before its upgrade, not a stranger's.
 */
function publishesOwnIdentity(published: PublishedIdentityJson, vault: KeyVault): 'same' | 'not-upgraded' | 'foreign' {
    if (!bytesEqual(fromBase64Url(published.publicKey), vault.identityPublicKey)) return 'foreign'
    if (!published.signingPublicKey) return 'not-upgraded'
    return vault.signingPublicKey && bytesEqual(fromBase64Url(published.signingPublicKey), vault.signingPublicKey) ? 'same' : 'foreign'
}

/**
 * Give the vault its signing key if it has none, and make sure the directory publishes the
 * vault's identity. `heldKey` is whatever this device holds for the vault.
 * @throws ForeignIdentityError when the server holds keys for the account the vault does not, and refuses the repair.
 */
export async function ensureAccountIdentity(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'getIdentity'>,
    heldKey: Uint8Array,
): Promise<AccountIdentityCheck> {
    let repaired = false
    try {
        const update = await updateVault(api, heldKey, {
            publishIdentity: true,
            async apply(vault) {
                // Read again on every attempt: another device of this account may have just
                // published the upgrade this one was about to make.
                const published = await api.getIdentity()
                // No identity at all is published by the write below, with nothing to warn about.
                const state = published ? publishesOwnIdentity(published, vault) : 'not-upgraded'
                repaired = state === 'foreign'
                return state === 'same' ? null : vault
            },
        })
        return { vault: update.vault, vaultKey: update.vaultKey, repaired }
    } catch (error) {
        if (error instanceof SyncApiError && (error.code === KEY_SIGNATURE_REFUSED_CODE || error.code === IDENTITY_PROOF_REFUSED_CODE)) {
            throw new ForeignIdentityError()
        }
        throw error
    }
}

/**
 * This account's own Security Fingerprint, for the other half of an invite check: the invite
 * dialog shows the invitee's and asks the inviter to compare it with theirs, which needs a screen
 * that shows each user their own. Runs the identity check first, so the fingerprint shown is the
 * one the server now publishes. Null when the account has no keys yet.
 */
export async function accountIdentityFingerprint(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'getIdentity'>,
    heldKey: Uint8Array,
): Promise<{ fingerprint: string; repaired: boolean } | null> {
    if (!(await api.getVault())) return null
    const check = await ensureAccountIdentity(api, heldKey)
    return { fingerprint: await fingerprint(identityPublicKeys(check.vault)!), repaired: check.repaired }
}
