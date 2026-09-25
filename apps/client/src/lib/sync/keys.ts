/**
 * Client key bootstrap for a Server-backed graph (plan Phase 4, ADR 0026). On first use it
 * generates the account identity keypair + Recovery Code + empty vault; thereafter it unlocks
 * the vault and ensures a Graph Keyring exists for the target graph. All secrets are
 * client-only - the server stores the vault as an opaque blob it can never read.
 *
 * Pure over an injected SyncApi so it unit-tests against a fetch stub.
 */
import {
    type GraphKeyring,
    type KeyVault,
    type OpenedVault,
    createGraphKeyring,
    deriveVaultWrapKey,
    encryptVault,
    fingerprint,
    fromBase64Url,
    generateIdentityKeyPair,
    generateRecoveryCode,
    openVault,
    reencryptVault,
    toBase64Url,
} from '$lib/crypto'
import type { VaultProtectionAccess } from '$lib/document/protection/protection-store'

import { SyncApiError, type SyncApi } from './sync-api'

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

/**
 * Mint an account's encryption keys before it owns any graph, so the Recovery Code ritual is a
 * step the user can take deliberately rather than a surprise at the end of their first import.
 * The vault starts empty; ensureGraphKeys adds each graph's keyring to it afterwards.
 */
export async function createAccountKeys(api: SyncApi): Promise<AccountKeyBootstrap> {
    if (await api.getVault()) throw new Error('This account already has encryption keys')
    const minted = await mintAccountVault(api, [])
    return { recoveryCode: minted.recoveryCode, deviceKey: minted.deviceKey, commit: minted.commit }
}

/** Identity + Recovery Code + an encrypted vault holding `keyrings`, written only by `commit`. */
async function mintAccountVault(
    api: SyncApi,
    keyrings: GraphKeyring[],
): Promise<{ vault: KeyVault; recoveryCode: string; deviceKey: Uint8Array; commit(): Promise<void> }> {
    const identity = generateIdentityKeyPair()
    const recoveryCode = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(recoveryCode)
    const vault: KeyVault = {
        identityPrivateKey: identity.privateKey,
        identityPublicKey: identity.publicKey,
        keyrings,
    }
    const { envelope, vaultKey } = await encryptVault(vault, wrapKey)
    return {
        vault,
        recoveryCode,
        deviceKey: vaultKey,
        commit: async () => {
            await api.putVault(toBase64Url(envelope), 0)
            await api.putIdentity(toBase64Url(identity.publicKey))
        },
    }
}

export async function ensureGraphKeys(
    api: SyncApi,
    graphId: string,
    getWrapKey: () => Promise<Uint8Array>,
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

    // Existing account: unlock, ensure a keyring for this graph, persist if we added one.
    // The held key may be the code-derived wrap key OR the vault key (device-approval /
    // cached) - openVault accepts either.
    const held = await getWrapKey()
    const previous = fromBase64Url(existing.vault)
    const opened = await openVault(previous, held)
    const vault = opened.vault
    let keyring = vault.keyrings.find((k) => k.graphId === graphId)
    let deviceKey = opened.vaultKey
    if (!keyring) {
        keyring = createGraphKeyring(graphId)
        vault.keyrings = [...vault.keyrings, keyring]
        deviceKey = await putVaultWithRetry(api, vault, previous, opened, existing.version)
    }
    return { keyring, vault, deviceKey, commit: async () => {} }
}

/** A Recovery Code regenerate, prepared but not yet written (ADR 0029 rung 2, amended 2026-09-17). */
export interface RecoveryCodeRegeneration {
    /** Show this once. It opens nothing until `commit` succeeds; the current code works until then. */
    code: string
    /**
     * Retire the current code and activate this one, by re-WRAPPING the vault key under it.
     * Runs only once the user has confirmed they saved the code. The vault key is preserved,
     * so every other unlocked device stays unlocked. Resolves to the vault key this device
     * should cache - fresh only when a legacy blob was upgraded to v2 here.
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
export async function regenerateRecoveryCode(api: SyncApi, heldKey: Uint8Array): Promise<RecoveryCodeRegeneration> {
    const existing = await api.getVault()
    if (!existing) throw new Error('No vault to re-key on this account')
    // Opened now, so a held key that cannot open the vault fails before any code is shown.
    const opened = await openVault(fromBase64Url(existing.vault), heldKey)
    const code = generateRecoveryCode()
    const wrapKey = await deriveVaultWrapKey(code)
    // A legacy blob has no vault key yet; encryptVault mints one when none is passed.
    const rewrap = (o: Pick<OpenedVault, 'vault' | 'vaultKey' | 'legacy'>) =>
        encryptVault(o.vault, wrapKey, o.legacy ? undefined : o.vaultKey)

    return {
        code,
        async commit() {
            const first = await rewrap(opened)
            try {
                await api.putVault(toBase64Url(first.envelope), existing.version)
                return first.vaultKey
            } catch (err) {
                if (!(err instanceof SyncApiError && err.status === 409)) throw err
                // The dialog stays open for human time now, so another device may well have
                // written the vault since it was read (a keyring add, protection enabled). Re-read
                // and re-wrap the latest under the SAME code: the code on the user's screen must
                // be the code that ends up working. The held key still opens the latest blob -
                // the vault key survives every concurrent write, and a wrap key does too because
                // content writers carry the wrapped-key segment forward verbatim.
                const latest = await api.getVault()
                if (!latest) throw new Error('vault vanished during write')
                const current = await openVault(fromBase64Url(latest.vault), heldKey)
                const retry = await rewrap(current)
                await api.putVault(toBase64Url(retry.envelope), latest.version)
                return retry.vaultKey
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

/** Persist the vault, retrying once on a 409 (another device wrote concurrently).
 *  Returns the vault key the caller should cache (fresh when a legacy blob was upgraded). */
async function putVaultWithRetry(
    api: SyncApi,
    vault: KeyVault,
    previousEnvelope: Uint8Array,
    opened: Pick<OpenedVault, 'vaultKey' | 'legacy'>,
    expectedVersion: number,
): Promise<Uint8Array> {
    const first = await reencryptVault(vault, previousEnvelope, opened)
    try {
        await api.putVault(toBase64Url(first.envelope), expectedVersion)
        return first.vaultKey
    } catch {
        // Re-read, merge our new keyrings into the latest, and try once more. The vault key
        // survives concurrent writes (even a regenerate only re-wraps it), so it reopens the
        // latest blob directly.
        const latest = await api.getVault()
        if (!latest) throw new Error('vault vanished during write')
        const latestEnvelope = fromBase64Url(latest.vault)
        const current = await openVault(latestEnvelope, opened.vaultKey)
        const next: KeyVault = {
            ...current.vault,
            keyrings: mergeKeyrings(current.vault.keyrings, vault.keyrings),
            // Protection records merge per graph, ours winning: without this the retry spreads
            // only the server's copy and silently discards the record we were writing, so
            // enabling protection during a concurrent vault write would look like it worked and
            // then be gone on the next device (ADR 0057).
            ...mergedProtection(current.vault.protection, vault.protection),
        }
        const retry = await reencryptVault(next, latestEnvelope, current)
        await api.putVault(toBase64Url(retry.envelope), latest.version)
        return retry.vaultKey
    }
}

/**
 * Union protection records by graph id, `ours` winning a tie - it is the write in flight - with
 * one refusal: a graph the other device protected first, under a different key. Two devices
 * enabling protection for one graph at the same moment both mint a key; letting the second write
 * win would replace the first record and orphan everything already sealed under it, and that key
 * is unrecoverable by design (ADR 0057). A record under the SAME fingerprint is a re-wrap
 * of the same key - a passphrase change - and passes. Returns an empty object when neither side
 * has any, so the vault stays byte-identical to one written before protection existed.
 */
function mergedProtection(
    theirs: KeyVault['protection'],
    ours: KeyVault['protection'],
): Pick<KeyVault, 'protection'> | Record<string, never> {
    for (const [graphId, record] of Object.entries(ours ?? {})) {
        const existing = theirs?.[graphId]
        if (existing && existing.fingerprint !== record.fingerprint) {
            throw new Error('another device protected this graph first; reload, then unlock with the passphrase chosen there')
        }
    }
    const merged = { ...(theirs ?? {}), ...(ours ?? {}) }
    return Object.keys(merged).length > 0 ? { protection: merged } : {}
}

/** Union keyrings by graphId, preferring the one with more epochs (the more-advanced copy). */
function mergeKeyrings(a: GraphKeyring[], b: GraphKeyring[]): GraphKeyring[] {
    const byId = new Map<string, GraphKeyring>()
    for (const k of [...a, ...b]) {
        const existing = byId.get(k.graphId)
        if (!existing || k.epochs.length > existing.epochs.length) byId.set(k.graphId, k)
    }
    return [...byId.values()]
}

/**
 * This account's own identity fingerprint, for the other half of an invite check.
 *
 * The invite dialog shows the invitee's fingerprint and asks the inviter to confirm it matches
 * "theirs, verified in person or over a call". That comparison, the out-of-band check ADR 0026
 * relies on to guard against server key substitution, needs a screen that shows each user their
 * own.
 *
 * Formatted by the same `fingerprint()` the invite side uses, so the two strings are visually
 * comparable character for character.
 */
export async function accountIdentityFingerprint(
    api: SyncApi,
    getWrapKey: () => Promise<Uint8Array>,
): Promise<string | null> {
    const existing = await api.getVault()
    // No vault means no identity key yet, so there is nothing to read out.
    if (!existing) return null
    const opened = await openVault(fromBase64Url(existing.vault), await getWrapKey())
    return fingerprint(opened.vault.identityPublicKey)
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
export function vaultProtectionAccess(
    api: SyncApi,
    getWrapKey: () => Promise<Uint8Array>,
): VaultProtectionAccess {
    return {
        async readProtection() {
            const existing = await api.getVault()
            if (!existing) return undefined
            const opened = await openVault(fromBase64Url(existing.vault), await getWrapKey())
            return opened.vault.protection
        },
        async writeProtection(next) {
            const existing = await api.getVault()
            if (!existing) throw new Error('this account has no vault yet')
            const previousEnvelope = fromBase64Url(existing.vault)
            const opened = await openVault(previousEnvelope, await getWrapKey())
            const vault: KeyVault = { ...opened.vault, protection: next }
            await putVaultWithRetry(api, vault, previousEnvelope, opened, existing.version)
        },
    }
}
