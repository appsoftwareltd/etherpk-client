/**
 * Device approval (ADR 0026 flows): unlock a NEW device from an already-unlocked one, so
 * the Recovery Code stays in the drawer for genuine recovery. The new device generates an
 * ephemeral X25519 pair and shows a SAS derived from its public key; an unlocked device
 * shows the SAS it derives from the key it RECEIVED, the user compares the two screens,
 * and on approve the vault key travels sealed to the ephemeral key. The server brokers
 * blind - a substituted key would change the SAS, and the sealed box it carries opens only
 * on the requesting device.
 *
 * Pure over an injected SyncApi so it unit-tests against a fetch stub.
 */
import {
    contextAad,
    deviceApprovalSas,
    fromBase64Url,
    generateIdentityKeyPair,
    openSealed,
    openVault,
    reencryptVault,
    sealToPublicKey,
    toBase64Url,
} from '$lib/crypto'
import type { SyncApi } from './sync-api'

/** AAD binds the sealed vault key to its approval - a blob cannot be replayed across requests. */
const approvalAad = (approvalId: string) => contextAad('device-approval', `approval:${approvalId}`)

export interface DeviceApprovalRequest {
    id: string
    /** The code THIS device displays; the approver must see the same one. */
    sas: string
    ephemeralPrivateKey: Uint8Array
}

/** New device: register a request and derive the SAS to display. */
export async function beginDeviceApproval(api: SyncApi): Promise<DeviceApprovalRequest> {
    const pair = generateIdentityKeyPair() // ephemeral X25519 - same curve as identities
    const { id } = await api.createDeviceApproval(toBase64Url(pair.publicKey))
    return { id, sas: await deviceApprovalSas(pair.publicKey), ephemeralPrivateKey: pair.privateKey }
}

export type ApprovalPoll =
    | { state: 'waiting' }
    | { state: 'rejected' }
    | { state: 'expired' }
    | { state: 'unlocked'; deviceKey: Uint8Array }

/**
 * New device: poll for the outcome. On 'unlocked' the sealed blob has been claimed (the
 * server clears it), opened with the ephemeral key, and VERIFIED against the account vault
 * - the returned deviceKey provably decrypts this account's keys.
 */
export async function pollDeviceApproval(api: SyncApi, request: DeviceApprovalRequest): Promise<ApprovalPoll> {
    const res = await api.pollDeviceApproval(request.id)
    if (res.status === 'pending') return { state: 'waiting' }
    if (res.status === 'rejected') return { state: 'rejected' }
    if (res.status === 'expired') return { state: 'expired' }
    if (res.status === 'sealed' && res.sealedVaultKey) {
        const deviceKey = await openSealed(request.ephemeralPrivateKey, fromBase64Url(res.sealedVaultKey), approvalAad(request.id))
        const vault = await api.getVault()
        if (!vault) throw new Error('No vault on this account')
        await openVault(fromBase64Url(vault.vault), deviceKey) // throws if the sealed key is wrong
        return { state: 'unlocked', deviceKey }
    }
    // 'claimed' with no blob means a previous poll consumed it and something went wrong after.
    throw new Error(`Approval is in an unexpected state (${res.status}) - start again`)
}

export interface PendingDeviceApproval {
    id: string
    ephemeralPublicKey: string
    createdAt: string
}

/** Approver: the SAS to show for a pending request - derived from the RECEIVED key. */
export function approvalSas(approval: PendingDeviceApproval): Promise<string> {
    return deviceApprovalSas(fromBase64Url(approval.ephemeralPublicKey))
}

/**
 * Approver: seal this account's vault key to the request's ephemeral key. `heldKey` is
 * whatever this device caches (wrap key or vault key - openVault takes either). A legacy
 * vault is upgraded to v2 first, minting the vault key there is to seal. Returns the vault
 * key so the caller can re-cache it (self-healing, and required after an upgrade).
 */
export async function approveDevice(api: SyncApi, approval: PendingDeviceApproval, heldKey: Uint8Array): Promise<Uint8Array> {
    const stored = await api.getVault()
    if (!stored) throw new Error('No vault on this account')
    const envelope = fromBase64Url(stored.vault)
    const opened = await openVault(envelope, heldKey)
    let vaultKey = opened.vaultKey
    if (opened.legacy) {
        const upgraded = await reencryptVault(opened.vault, envelope, opened)
        await api.putVault(toBase64Url(upgraded.envelope), stored.version)
        vaultKey = upgraded.vaultKey
    }
    const sealed = await sealToPublicKey(fromBase64Url(approval.ephemeralPublicKey), vaultKey, approvalAad(approval.id))
    await api.sealDeviceApproval(approval.id, toBase64Url(sealed))
    return vaultKey
}

/** Approver rejects / requestor cancels. */
export async function rejectDeviceApproval(api: SyncApi, approvalId: string): Promise<void> {
    await api.cancelDeviceApproval(approvalId)
}
