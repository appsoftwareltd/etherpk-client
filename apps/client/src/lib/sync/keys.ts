/**
 * Client key bootstrap for a Server-backed graph (plan Phase 4, ADR 0026). On first use it
 * generates the account's Sync Identity + Recovery Code + empty vault; thereafter it unlocks
 * the vault and ensures a Graph Keyring exists for the target graph. All secrets are
 * client-only - the server stores the vault as an opaque blob it can never read.
 *
 * Every write of the vault is signed by the account's signing key (ADR 0126) and made through
 * `updateVault`, which applies its change again when another device wrote first.
 *
 * Pure over an injected SyncApi so it unit-tests against a fetch stub.
 */
import {
    type GraphKeyring,
    type KeyVault,
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    generateSigningKeyPair,
    openVault,
} from '$lib/crypto'
import type { VaultProtectionAccess } from '$lib/document/protection/protection-store'

import type { SyncApi } from './sync-api'
import { updateVault, writeSignedVault } from './vault-update'

export interface KeyBootstrapResult {
    keyring: GraphKeyring
    vault: KeyVault
    /** The VAULT key - cache it on the device (vault-session) so the user unlocks once.
     *  It survives a Recovery Code regenerate (which only re-wraps it). */
    deviceKey: Uint8Array
    /** Set only when a brand-new account vault was created - the UI must show the ritual. */
    recoveryCodeJustGenerated?: string
    /**
     * Persist the account's vault + identity to the server (ADR 0029 prevention). For a FRESH
     * account these writes are DEFERRED until the caller confirms the Recovery Code was saved,
     * so an abandoned ritual leaves no locked-out server state. A no-op for existing accounts
     * (already persisted). Idempotent; safe to call once after the code is acknowledged.
     */
    commit(): Promise<void>
}

/**
 * Ensure the account has a vault (creating identity + Recovery Code + vault on first use),
 * then ensure a Graph Keyring exists for `graphId`. `getWrapKey` supplies the vault wrap key
 * - from the Recovery Code at recovery time, or a device-approval-sealed key day-to-day.
 * For a fresh account the vault/identity writes are returned as `commit()` and must run only
 * after the user has saved the Recovery Code (ADR 0029).
 */
export interface AccountKeyBootstrap {
    /** Show this once. It is the only thing that opens the vault on a device with no key. */
    recoveryCode: string
    /** The VAULT key to cache on this device once the code is acknowledged. */
    deviceKey: Uint8Array
    /** Writes the vault + identity. Deferred until the code is saved, exactly as ADR 0029 requires. */
    commit(): Promise<void>
}

type KeysApi = Pick<SyncApi, 'getVault' | 'putKeys' | 'me'>

/** The account already has a vault, typically because another device created its keys first. */
export class VaultExistsError extends Error {
    constructor() {
        super('This account already has Encryption Keys')
        this.name = 'VaultExistsError'
    }
}

/**
 * Mint an account's encryption keys before it owns any graph, so the Recovery Code ritual is a
 * step the user can take deliberately rather than a surprise at the end of their first import.
 * The vault starts empty; ensureGraphKeys adds each graph's keyring to it afterwards.
 */
export async function createAccountKeys(api: KeysApi): Promise<AccountKeyBootstrap> {
    if (await api.getVault()) throw new VaultExistsError()
    const minted = await mintAccountVault(api, [])
    return { recoveryCode: minted.recoveryCode, deviceKey: minted.deviceKey, commit: minted.commit }
}

/**
 * A Sync Identity (both key pairs) + Recovery Code + an encrypted vault holding `keyrings`,
 * written only by `commit`.
 */
async function mintAccountVault(
    api: KeysApi,
    keyrings: GraphKeyring[],
): Promise<{ vault: KeyVault; recoveryCode: string; deviceKey: Uint8Array; commit(): Promise<void> }> {
    const identity = generateIdentityKeyPair()
    const signing = generateSigningKeyPair()
    const recoveryCode = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(recoveryCode)
    const vault: KeyVault = {
        identityPrivateKey: identity.privateKey,
        identityPublicKey: identity.publicKey,
        signingPrivateKey: signing.privateKey,
        signingPublicKey: signing.publicKey,
        keyrings,
    }
    // The vault key is minted now, because the device caches it once the code is acknowledged.
    const { vaultKey } = await encryptVault(vault, wrapKey)
    return {
        vault,
        recoveryCode,
        deviceKey: vaultKey,
        commit: async () => {
            // The signature names the account, and with no vault yet there is none to read it from.
            const { principal } = await api.me()
            await writeSignedVault(api, vault, {
                principalId: principal.id,
                expectedVersion: 0,
                seal: (content) => encryptVault(content, wrapKey, vaultKey),
                publishIdentity: true,
            })
        },
    }
}

/**
 * The account's vault holds no key for a graph it is a member of (ADR 0127). A Graph Key is
 * minted only when a graph is created: minting one for an existing graph would encrypt this
 * device's edits under a key nobody else holds.
 */
export class MissingGraphKeyError extends Error {
    constructor(readonly graphId: string) {
        super(`This account's Encryption Keys hold no Graph Key for graph ${graphId}.`)
        this.name = 'MissingGraphKeyError'
    }
}

export async function ensureGraphKeys(
    api: KeysApi,
    graphId: string,
    getWrapKey: () => Promise<Uint8Array>,
    /**
     * `true` only for a graph this device has just created, the one case a Graph Key may be
     * minted. Opening an existing graph whose key the vault lacks fails with
     * {@link MissingGraphKeyError} instead. An account with no vault yet is the exception: its
     * keys were never saved, so no key for the graph is held anywhere, and its first keys are
     * minted with the graph's.
     */
    options: { newGraph?: boolean } = {},
): Promise<KeyBootstrapResult> {
    const existing = await api.getVault()

    if (!existing) {
        // Fresh account: mint identity + Recovery Code + this graph's keyring, but DO NOT write
        // to the server yet - the caller commits after the user acknowledges the code.
        const keyring = createGraphKeyring(graphId)
        const minted = await mintAccountVault(api, [keyring])
        return {
            keyring,
            vault: minted.vault,
            deviceKey: minted.deviceKey,
            recoveryCodeJustGenerated: minted.recoveryCode,
            commit: minted.commit,
        }
    }

    // Existing account: unlock, and add a keyring for a NEW graph unless the vault has one. The
    // held key may be the code-derived wrap key OR the vault key (device-approval / cached) -
    // openVault accepts either. Applied to the latest vault, so a keyring another device added
    // a moment ago is used rather than a second one minted beside it.
    const update = await updateVault(api, await getWrapKey(), {
        apply: (vault) => {
            if (vault.keyrings.some((k) => k.graphId === graphId)) return null
            if (!options.newGraph) throw new MissingGraphKeyError(graphId)
            return { ...vault, keyrings: [...vault.keyrings, createGraphKeyring(graphId)] }
        },
    })
    const keyring = update.vault.keyrings.find((k) => k.graphId === graphId)!
    return { keyring, vault: update.vault, deviceKey: update.vaultKey, commit: async () => {} }
}

/** A Recovery Code regenerate, prepared but not yet written (ADR 0029 rung 2, amended 2026-09-17). */
export interface RecoveryCodeRegeneration {
    /** Show this once. It opens nothing until `commit` succeeds; the current code works until then. */
    code: string
    /**
     * Retire the current code and activate this one, by re-WRAPPING the vault key under it.
     * Runs only once the user has confirmed they saved the code. The vault key is preserved,
     * so every other unlocked device stays unlocked. Resolves to the vault key this device
     * should cache - fresh only when a legacy blob was upgraded here.
     */
    commit(): Promise<Uint8Array>
    /**
     * After `commit` threw: did the write land anyway? A request can time out after the server
     * applied it, and telling the user "your old code still works" when it does not is the
     * data loss the deferred write exists to prevent. Resolves to the vault key when the vault
     * on the server now opens under this code, null when it does not. Rejects when the server
     * cannot be reached, which the caller must report as "could not confirm".
     */
    activeVaultKey(): Promise<Uint8Array | null>
}

/**
 * Prepare a lossless Recovery Code regenerate (ADR 0029, the "I did not save it" fix): open
 * the vault with whatever key this device holds and mint a fresh code, but write NOTHING -
 * the re-wrap is the returned `commit`, gated on the user confirming they have saved the code,
 * exactly as the first mint's vault write is. Until then the current code keeps working and
 * abandoning the new one changes nothing. (Regenerate once re-wrapped before showing the code,
 * which made a crash between the press and the save cost the account its only credential.)
 */
export async function regenerateRecoveryCode(api: KeysApi, heldKey: Uint8Array): Promise<RecoveryCodeRegeneration> {
    const existing = await api.getVault()
    if (!existing) throw new Error('No vault to re-key on this account')
    // Opened now, so a held key that cannot open the vault fails before any code is shown.
    await openVault(fromBase64Url(existing.vault), heldKey)
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)

    return {
        code,
        async commit() {
            // The dialog stays open for human time, so another device may well write the vault
            // before this commit (a keyring add, protection enabled). updateVault re-wraps the
            // latest under the SAME code: the code on the user's screen must be the code that
            // ends up working. The held key still opens the latest blob - the vault key survives
            // every concurrent write, and a wrap key does too because content writers carry the
            // wrapped-key segment forward verbatim.
            const update = await updateVault(api, heldKey, {
                // The content is unchanged: what changes is the key it is wrapped under.
                apply: (vault) => vault,
                // A legacy blob has no vault key yet; encryptVault mints one when none is passed.
                seal: (vault, { opened }) => encryptVault(vault, wrapKey, opened.legacy ? undefined : opened.vaultKey),
            })
            return update.vaultKey
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

/**
 * Vault-backed storage for a Server Backend graph's {@link ProtectionRecord} (ADR 0057).
 *
 * Protection records are **personal**, so they cannot live in the graph's encrypted *shared*
 * metadata (ADR 0031) where every Player would hold the passphrase-wrapped blob and could attack
 * it offline. The account vault is the one place that is per-user and reachable from every one of
 * that user's devices.
 *
 * Nesting a wrapped key inside the vault is not circular: the vault yields only the
 * passphrase-wrapped copy, so a device that has cached its vault key - which is every unlocked
 * device, in `localStorage` - still cannot read protected content.
 */
export function vaultProtectionAccess(api: KeysApi, getWrapKey: () => Promise<Uint8Array>): VaultProtectionAccess {
    return {
        async readProtection() {
            const existing = await api.getVault()
            if (!existing) return undefined
            const opened = await openVault(fromBase64Url(existing.vault), await getWrapKey())
            return opened.vault.protection
        },
        async writeProtection(graphId, record) {
            await updateVault(api, await getWrapKey(), {
                apply: (vault) => {
                    // One refusal: a record under a different key, which another device wrote
                    // first. Replacing it would orphan everything already sealed under that key,
                    // and the key is unrecoverable by design (ADR 0057). The same fingerprint is a
                    // re-wrap of the same key - a passphrase change - and passes.
                    const existing = vault.protection?.[graphId]
                    if (record && existing && existing.fingerprint !== record.fingerprint) {
                        throw new Error('another device protected this graph first - reload, then unlock with the passphrase chosen there')
                    }
                    const protection = { ...vault.protection }
                    if (record) protection[graphId] = record
                    else delete protection[graphId]
                    return { ...vault, protection }
                },
            })
        },
    }
}
