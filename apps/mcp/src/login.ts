/**
 * How the [[Headless Client]] gets the vault key the first time, as a device of the account
 * (ADR 0072). Two routes, both already served by the Sync Server for every new device:
 *
 * - **Device Approval** (ADR 0034), the default: this process registers an ephemeral key and
 *   prints the SAS; the user confirms the same code in any unlocked EtherPK tab, which seals the
 *   vault key to the ephemeral key; the poll claims it and verifies it opens the vault. No secret
 *   passes through the terminal.
 * - **Recovery Code**, behind a flag, for a box with no tab to hand: the code derives the wrap
 *   key, which opens the vault; what is cached is the vault key, never the code.
 *
 * Pure over an injected clock and output so the flow is testable without a terminal.
 */

import { openVaultWithRecoveryCode } from '$lib/sync/recovery-unlock'
import { beginDeviceApproval, pollDeviceApproval } from '$lib/sync/device-approval'
import type { SyncApi } from '$lib/sync/sync-api'

export interface LoginIo {
    /** A line for the user: the SAS, progress, the outcome. Never a secret. */
    say(line: string): void
    sleep(ms: number): Promise<void>
    /**
     * Aborts the wait: the user chose another route or pressed Ctrl-C. The pending approval is
     * cancelled server-side and {@link ApprovalAbandoned} is thrown, so the caller can tell a
     * deliberate switch from a failure.
     */
    signal?: AbortSignal
    /** Where the EtherPK Client lives, to name in the instruction; null when the Server did not say. */
    clientUrl?: string | null
}

/** The user left the approval wait on purpose (the signal fired); nothing went wrong. */
export class ApprovalAbandoned extends Error {
    constructor() {
        super('Approval abandoned.')
        this.name = 'ApprovalAbandoned'
    }
}

/** Approval rows expire server-side after ten minutes; poll a little longer and then give up. */
const APPROVAL_TIMEOUT_MS = 11 * 60_000
const APPROVAL_POLL_MS = 2_000

export async function unlockByDeviceApproval(api: SyncApi, io: LoginIo): Promise<Uint8Array> {
    const request = await beginDeviceApproval(api)
    const where = io.clientUrl ? `open EtherPK at ${io.clientUrl}` : 'open EtherPK in a browser'
    io.say('')
    io.say(`To approve this device, ${where} (any page - it need not be a note) signed in to this account`)
    io.say('with its graphs unlocked. A prompt will show a code; confirm it matches this one:')
    io.say('')
    io.say(`    ${request.sas}`)
    io.say('')
    io.say('Waiting (up to ten minutes)…')
    const abandon = async () => {
        await api.cancelDeviceApproval(request.id).catch(() => {})
        throw new ApprovalAbandoned()
    }
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS
    while (Date.now() < deadline) {
        if (io.signal?.aborted) await abandon()
        const outcome = await pollDeviceApproval(api, request)
        if (outcome.state === 'unlocked') return outcome.deviceKey
        if (outcome.state === 'rejected') throw new Error('The approval was rejected in EtherPK.')
        if (outcome.state === 'expired') throw new Error('The approval expired before it was confirmed. Run login again.')
        await io.sleep(APPROVAL_POLL_MS)
        if (io.signal?.aborted) await abandon()
    }
    throw new Error('The approval was not confirmed in time. Run login again.')
}

/**
 * Recovery Code → wrap key → open the vault; what comes back is the vault key to cache. The same
 * check the browser makes (recovery-unlock.ts): a wrong code is refused as wrong and nothing is cached.
 */
export async function unlockByRecoveryCode(api: SyncApi, code: string): Promise<Uint8Array> {
    return openVaultWithRecoveryCode(api, code)
}
