/**
 * Every write of an account's vault (ADR 0026), signed by the account's signing key (ADR 0126).
 *
 * A write is a read, a change and a write: read the vault, open it with the key this device holds,
 * apply the change to what was read, then seal, sign and write it against the version read. When
 * another device wrote in between, the server answers 409 and the change is applied again to the
 * newer vault, so one device's change never overwrites another's.
 *
 * A vault from before signing keys gets its signing key in the first write made to it, and that
 * write publishes the identity with it: the server must hold the key that signs every later one.
 */
import { keyWriteTranscript } from '@appsoftwareltd/etherpk-shared'
import {
    type EncryptedVault,
    type KeyVault,
    type OpenedVault,
    fromBase64Url,
    generateSigningKeyPair,
    identityHash,
    identityPossessionProof,
    identityPublicKeys,
    openVault,
    reencryptVault,
    sha256,
    signMessage,
    toBase64Url,
} from '$lib/crypto'
import { NoVaultError } from './recovery-unlock'
import { SyncApiError, type SyncApi } from './sync-api'

/** How many times a change is applied to a newer vault after other devices' writes before giving up. */
const MAX_ATTEMPTS = 3

/** The server refused a write because the vault moved on since it was read. */
export function isVersionConflict(error: unknown): boolean {
    return error instanceof SyncApiError && error.status === 409
}

/** The code a Sync Server older than this Client answers with, so the copy can say what to do. */
export const SERVER_UPGRADE_REQUIRED_CODE = 'server_upgrade_required'

/** The vault with a signing key pair, adding one when it has none. */
export function withSigningKey(vault: KeyVault): { vault: KeyVault; added: boolean } {
    if (vault.signingPrivateKey && vault.signingPublicKey) return { vault, added: false }
    const pair = generateSigningKeyPair()
    return { vault: { ...vault, signingPrivateKey: pair.privateKey, signingPublicKey: pair.publicKey }, added: true }
}

/**
 * Seal, sign and write `vault` against `expectedVersion`. A vault with no signing key gets one,
 * and then its identity is published with the write whatever `publishIdentity` says.
 */
export async function writeSignedVault(
    api: Pick<SyncApi, 'putKeys'>,
    vault: KeyVault,
    options: {
        /** The account the vault belongs to. The signature names it, so it cannot be replayed elsewhere. */
        principalId: string
        /** The version this write replaces; 0 creates the vault. */
        expectedVersion: number
        seal: (vault: KeyVault) => Promise<EncryptedVault>
        publishIdentity?: boolean
        /**
         * The key the server offers to prove the identity on record against, which it does while
         * that identity has no signing key. A write that publishes the identity then carries the proof.
         */
        identityProofKey?: Uint8Array
    },
): Promise<{ vault: KeyVault; vaultKey: Uint8Array; version: number }> {
    const signed = withSigningKey(vault)
    const { envelope, vaultKey } = await options.seal(signed.vault)
    const identity = options.publishIdentity || signed.added ? identityPublicKeys(signed.vault) : null
    const transcript = keyWriteTranscript({
        principalId: options.principalId,
        expectedVersion: options.expectedVersion,
        vaultHash: await sha256(envelope),
        identityHash: identity ? await identityHash(identity) : null,
    })
    // An identity published before signing keys gets its first one only with proof that this
    // device holds the identity's X25519 private key, which nothing else on record can show.
    const identityProof =
        identity && options.identityProofKey
            ? await identityPossessionProof(signed.vault.identityPrivateKey, options.identityProofKey, transcript)
            : null
    const version = await api.putKeys({
        vault: toBase64Url(envelope),
        expectedVersion: options.expectedVersion,
        ...(identity
            ? { identity: { publicKey: toBase64Url(identity.publicKey), signingPublicKey: toBase64Url(identity.signingPublicKey) } }
            : {}),
        signature: toBase64Url(signMessage(transcript, signed.vault.signingPrivateKey!)),
        ...(identityProof ? { identityProof: toBase64Url(identityProof) } : {}),
    })
    return { vault: signed.vault, vaultKey, version }
}

export interface VaultChange {
    /**
     * The new content, worked out from the vault as the server holds it now, or null to write
     * nothing. It runs again after another device's write, so it must work only from what it is
     * given. `principalId` is the account the vault belongs to, which signed transcripts name.
     */
    apply(vault: KeyVault, opened: OpenedVault, principalId: string): KeyVault | null | Promise<KeyVault | null>
    /** How the new content is sealed. By default against the envelope read, keeping its wrapped vault key. */
    seal?(vault: KeyVault, read: { envelope: Uint8Array; opened: OpenedVault }): Promise<EncryptedVault>
    /** Publish the vault's identity with this write, as the own-key check does to repair the directory. */
    publishIdentity?: boolean
}

export interface VaultUpdate {
    /** The vault as the server now holds it: the content written, or what was read when nothing was. */
    vault: KeyVault
    /** The key to cache on this device: the vault key, new only when a legacy vault was upgraded. */
    vaultKey: Uint8Array
    /** The account the vault belongs to, as the server named it: what this account signs as. */
    principalId: string
    written: boolean
}

/**
 * Read the vault, apply `change` and write the result, signed, applying it again to the newer
 * vault when another device wrote first. `heldKey` is whatever this device holds: the vault key or
 * a wrap key from the Recovery Code.
 * @throws NoVaultError when the account has no vault.
 */
export async function updateVault(
    api: Pick<SyncApi, 'getVault' | 'putKeys'>,
    heldKey: Uint8Array,
    change: VaultChange,
): Promise<VaultUpdate> {
    for (let attempt = 1; ; attempt++) {
        const stored = await api.getVault()
        if (!stored) throw new NoVaultError()
        // A Sync Server from before ADR 0126 does not say whose vault it is, and refuses the write anyway.
        if (typeof stored.principalId !== 'string') {
            throw new SyncApiError('This Sync Server needs updating before it can save keys.', 426, SERVER_UPGRADE_REQUIRED_CODE)
        }
        const envelope = fromBase64Url(stored.vault)
        const opened = await openVault(envelope, heldKey)
        const next = await change.apply(opened.vault, opened, stored.principalId)
        if (!next) return { vault: opened.vault, vaultKey: opened.vaultKey, principalId: stored.principalId, written: false }
        try {
            const written = await writeSignedVault(api, next, {
                principalId: stored.principalId,
                expectedVersion: stored.version,
                seal: (vault) => (change.seal ? change.seal(vault, { envelope, opened }) : reencryptVault(vault, envelope, opened)),
                publishIdentity: change.publishIdentity,
                identityProofKey: stored.identityProofKey ? fromBase64Url(stored.identityProofKey) : undefined,
            })
            return { vault: written.vault, vaultKey: written.vaultKey, principalId: stored.principalId, written: true }
        } catch (error) {
            if (isVersionConflict(error) && attempt < MAX_ATTEMPTS) continue
            throw error
        }
    }
}
