/**
 * Device approval (ADR 0125, amending ADR 0034): unlock a NEW device from an already-unlocked one,
 * so the Recovery Code stays in the drawer for genuine recovery.
 *
 * Both devices contribute a one-time X25519 key, and commit-then-reveal keeps either side from
 * choosing its key after seeing the other's (`crypto/device-sas.ts` has the cryptography):
 *
 * 1. The new device posts only a commitment to its key (`beginDeviceApproval`).
 * 2. The first unlocked device to see the request answers with its own key
 *    (`answerDeviceApproval`). Any other approving device is told the request is taken.
 * 3. The new device, seeing the answer, reveals its key and shows the code (`pollDeviceApproval`).
 * 4. The approving device checks the reveal against the commitment and shows its code
 *    (`readApproverExchange`). A server that substituted either key makes the codes differ.
 * 5. On approval the vault key travels encrypted under a key only these two devices derive
 *    (`approveDevice`), and the new device checks that it opens this account's vault.
 *
 * The new device must still have the user confirm the codes match before it uses the key: a
 * server can play the approving device itself, and only the user, looking at both screens, can
 * tell. That confirmation lives in the dialog, not here.
 *
 * Pure over an injected SyncApi so it unit-tests against a fetch stub.
 */
import {
    approvalCode,
    approvalCommitment,
    approvalReplyKey,
    approvalTranscript,
    commitmentMatches,
    fromBase64Url,
    generateIdentityKeyPair,
    openApprovalReply,
    openVault,
    sealApprovalReply,
    toBase64Url,
} from '$lib/crypto'
import { SyncApiError, type PendingDeviceApproval, type SyncApi } from './sync-api'
import { updateVault } from './vault-update'

export type { PendingDeviceApproval } from './sync-api'

/** A request this device made, and what it has learned of the exchange so far. */
export interface DeviceApprovalRequest {
    id: string
    /** This device's one-time key pair. The private half never leaves memory. */
    privateKey: Uint8Array
    publicKey: Uint8Array
    commitment: Uint8Array
    /** Set once an approving device answered and this device revealed its key. */
    exchange?: { approverPublicKey: Uint8Array; transcript: Uint8Array; sas: string }
}

/** New device: make a one-time key pair and post only a commitment to it. */
export async function beginDeviceApproval(api: SyncApi): Promise<DeviceApprovalRequest> {
    const pair = generateIdentityKeyPair() // a one-time X25519 pair, the same curve as identities
    const commitment = await approvalCommitment(pair.publicKey)
    const { id } = await api.createDeviceApproval(toBase64Url(commitment))
    return { id, privateKey: pair.privateKey, publicKey: pair.publicKey, commitment }
}

export type ApprovalPoll =
    /** No unlocked device has answered yet, so there is no code to show. */
    | { state: 'waiting' }
    /** The code to compare. The other device has not approved yet. */
    | { state: 'code'; sas: string }
    /** The other device approved, and the key it sent opens this account's vault. */
    | { state: 'approved'; sas: string; deviceKey: Uint8Array }
    | { state: 'rejected' }
    | { state: 'expired' }

/**
 * New device: one step of the exchange. On the first poll after an approving device answers, this
 * reveals the device's key and returns the code to show. A sealed reply is claimed (the server
 * hands it over once), opened under the key from this exchange, and checked against the account's
 * vault before it is returned. Callers must not overlap calls for one request: the claim is one-shot.
 */
export async function pollDeviceApproval(api: SyncApi, request: DeviceApprovalRequest): Promise<ApprovalPoll> {
    const res = await api.pollDeviceApproval(request.id)
    if (res.status === 'pending') return { state: 'waiting' }
    if (res.status === 'rejected') return { state: 'rejected' }
    if (res.status === 'expired') return { state: 'expired' }
    if (res.status === 'answered' || res.status === 'revealed' || res.status === 'sealed') {
        if (!request.exchange) {
            if (!res.approverPublicKey) throw new Error('The approving device sent no key - start again')
            const approverPublicKey = fromBase64Url(res.approverPublicKey)
            const transcript = await approvalTranscript({
                approvalId: request.id,
                commitment: request.commitment,
                approverPublicKey,
                requesterPublicKey: request.publicKey,
            })
            if (res.status === 'answered') await api.revealDeviceApproval(request.id, toBase64Url(request.publicKey))
            request.exchange = { approverPublicKey, transcript, sas: approvalCode(transcript) }
        }
        const { sas } = request.exchange
        if (res.status !== 'sealed' || !res.sealedVaultKey) return { state: 'code', sas }
        const replyKey = await approvalReplyKey(request.privateKey, request.exchange.approverPublicKey, request.exchange.transcript)
        const deviceKey = await openApprovalReply(replyKey, fromBase64Url(res.sealedVaultKey), request.id)
        const vault = await api.getVault()
        if (!vault) throw new Error('No vault on this account')
        await openVault(fromBase64Url(vault.vault), deviceKey) // throws if the key opens nothing of this account's
        return { state: 'approved', sas, deviceKey }
    }
    // 'claimed' with no reply means a previous poll consumed it and something went wrong after.
    throw new Error(`Approval is in an unexpected state (${res.status}) - start again`)
}

/** An approving device's side of one exchange: the key pair it answered with. */
export interface ApproverSession {
    approvalId: string
    commitment: Uint8Array
    privateKey: Uint8Array
    publicKey: Uint8Array
    /** Set once the new device revealed a key that matches its commitment. */
    exchange?: { requesterPublicKey: Uint8Array; transcript: Uint8Array; sas: string }
}

/**
 * Approving device: answer a pending request with a one-time key pair of its own. `'taken'` when
 * another device answered first, which is then the only device that can approve it.
 */
export async function answerDeviceApproval(api: SyncApi, approval: PendingDeviceApproval): Promise<ApproverSession | 'taken'> {
    const pair = generateIdentityKeyPair()
    try {
        await api.respondToDeviceApproval(approval.id, toBase64Url(pair.publicKey))
    } catch (error) {
        if (error instanceof SyncApiError && error.status === 409) return 'taken'
        throw error
    }
    return { approvalId: approval.id, commitment: fromBase64Url(approval.commitment), privateKey: pair.privateKey, publicKey: pair.publicKey }
}

/** The new device revealed a key that does not match the commitment it posted: someone swapped it. */
export class ApprovalTamperedError extends Error {
    constructor() {
        super('The new device sent a key that does not match the one it promised. Someone may be interfering: reject this request.')
        this.name = 'ApprovalTamperedError'
    }
}

/**
 * Approving device: read the new device's reveal from the listing, check it against the commitment
 * this device saw first, and work out the code to show. `null` while the new device has not
 * revealed yet. Rejects with `ApprovalTamperedError` when the reveal does not match.
 */
export async function readApproverExchange(
    session: ApproverSession,
    listing: PendingDeviceApproval | undefined,
): Promise<ApproverSession['exchange'] | null> {
    if (session.exchange) return session.exchange
    if (!listing || listing.status !== 'revealed' || !listing.requesterPublicKey) return null
    const requesterPublicKey = fromBase64Url(listing.requesterPublicKey)
    // The commitment this device saw when it answered, never one re-read from the server.
    if (!(await commitmentMatches(session.commitment, requesterPublicKey))) throw new ApprovalTamperedError()
    const transcript = await approvalTranscript({
        approvalId: session.approvalId,
        commitment: session.commitment,
        approverPublicKey: session.publicKey,
        requesterPublicKey,
    })
    session.exchange = { requesterPublicKey, transcript, sas: approvalCode(transcript) }
    return session.exchange
}

/**
 * Approving device: encrypt this account's vault key for the new device and post it. `heldKey` is
 * whatever this device caches (wrap key or vault key - openVault takes either). A legacy vault is
 * upgraded to v2 first, minting the vault key there is to send. Returns the vault key so the
 * caller can cache it again (self-healing, and required after an upgrade).
 */
export async function approveDevice(api: SyncApi, session: ApproverSession, heldKey: Uint8Array): Promise<Uint8Array> {
    const exchange = session.exchange
    if (!exchange) throw new Error('The new device has not shown its code yet')
    // A legacy vault has no vault key to send; the write that upgrades it mints one. Any other
    // vault is only read.
    const { vaultKey } = await updateVault(api, heldKey, { apply: (vault, opened) => (opened.legacy ? vault : null) })
    const replyKey = await approvalReplyKey(session.privateKey, exchange.requesterPublicKey, exchange.transcript)
    await api.sealDeviceApproval(session.approvalId, toBase64Url(await sealApprovalReply(replyKey, vaultKey, session.approvalId)))
    return vaultKey
}

/** Approver rejects, or the new device cancels. */
export async function rejectDeviceApproval(api: SyncApi, approvalId: string): Promise<void> {
    await api.cancelDeviceApproval(approvalId)
}
