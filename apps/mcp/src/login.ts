/**
 * How the [[Headless Client]] gets the vault key the first time, as a device of the account
 * (ADR 0072). Two routes, both already served by the Sync Server for every new device:
 *
 * - **Device Approval** (ADR 0125), the default: this process posts a commitment to a one-time
 *   key; once an unlocked EtherPK tab answers, it prints the code both screens show. The user
 *   approves in the tab AND presses y here: a server can play the approving device itself, and
 *   only the user, comparing the two screens, can tell. The key that arrives is checked against
 *   the vault before it is used. No secret passes through the terminal.
 * - **Recovery Code**, behind a flag, for a box with no tab to hand: the code derives the wrap
 *   key, which opens the vault; what is cached is the vault key, never the code.
 *
 * Pure over an injected clock and output so the flow is testable without a terminal.
 */

import { openVaultWithRecoveryCode } from '$lib/sync/recovery-unlock'
import { beginDeviceApproval, pollDeviceApproval } from '$lib/sync/device-approval'
import type { SyncApi } from '$lib/sync/sync-api'

export interface LoginIo {
    /** A line for the user: the code, progress, the outcome. Never a secret. */
    say(line: string): void
    sleep(ms: number): Promise<void>
    /** Has the user confirmed that EtherPK shows the same code as this terminal (the y key)? */
    codesMatch(): boolean
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
/** How long a quit waits for the server to cancel the approval before leaving anyway. */
const CANCEL_TIMEOUT_MS = 5_000

/** Shell exit codes for the signals that end a login: 128 plus the signal's number. */
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const

export type QuitSignal = keyof typeof SIGNAL_EXIT_CODES

/**
 * The keys the approval wait answers to. `y` confirms the codes match; `n` says they do not, which
 * cancels the request; `r` switches to the Recovery Code; Ctrl-C (a key while the terminal is in
 * raw mode) and SIGINT, SIGTERM or SIGHUP quit. Every way out aborts the wait, so it cancels its
 * approval server-side before anything exits: a login left pending showed its stale code in every
 * unlocked tab for ten minutes. `exitCode` is set once the user has quit.
 */
export function approvalWaitControls() {
    const abort = new AbortController()
    let exitCode: number | null = null
    let confirmed = false
    let mismatched = false
    let inputClosed = false
    return {
        signal: abort.signal,
        get exitCode(): number | null {
            return exitCode
        },
        /** The user pressed y: EtherPK shows the same code. */
        get codesMatch(): boolean {
            return confirmed
        },
        /** The user pressed n: the codes differ, so something interfered. */
        get mismatched(): boolean {
            return mismatched
        },
        /** Piped input ended before a y, so nothing can ever confirm the codes. */
        get inputClosed(): boolean {
            return inputClosed
        },
        onInputClosed(): void {
            if (confirmed) return
            inputClosed = true
            abort.abort()
        },
        /** One keypress on a terminal, or a chunk of piped input such as "y\n": read a character at a time. */
        onKey(input: string): void {
            for (const key of input) {
                if (key === 'y' || key === 'Y') confirmed = true
                if (key === 'n' || key === 'N') {
                    mismatched = true
                    abort.abort()
                }
                if (key === 'r' || key === 'R') abort.abort()
                if (key === '\u0003') {
                    exitCode = SIGNAL_EXIT_CODES.SIGINT
                    abort.abort()
                }
            }
        },
        onSignal(name: QuitSignal): void {
            exitCode = SIGNAL_EXIT_CODES[name]
            abort.abort()
        },
    }
}

/** A sleep that ends as soon as the signal aborts, so a quit does not wait out the poll interval. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const done = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener('abort', done, { once: true })
    })
}

export async function unlockByDeviceApproval(api: SyncApi, io: LoginIo): Promise<Uint8Array> {
    const request = await beginDeviceApproval(api)
    const where = io.clientUrl ? `open EtherPK at ${io.clientUrl}` : 'open EtherPK in a browser'
    io.say('')
    io.say(`To approve this device, ${where} (any page - it need not be a note), connected to this account`)
    io.say('with its keys unlocked. A prompt will appear there, and this terminal then shows a code to compare.')
    io.say('')
    io.say('Waiting (up to ten minutes)…')
    const abandon = async () => {
        // Bounded, so quitting cannot hang on a server that has stopped answering.
        await Promise.race([
            api.cancelDeviceApproval(request.id).catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, CANCEL_TIMEOUT_MS).unref()),
        ])
        throw new ApprovalAbandoned()
    }
    let shown = false
    // The other device approved, but the user has not yet confirmed the codes match.
    let approved: Uint8Array | null = null
    let toldApproved = false
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS
    while (Date.now() < deadline) {
        if (io.signal?.aborted) await abandon()
        if (!approved) {
            const outcome = await pollDeviceApproval(api, request)
            if (outcome.state === 'rejected') throw new Error('The approval was rejected in EtherPK.')
            if (outcome.state === 'expired') throw new Error('The approval expired before it was confirmed. Run login again.')
            if ((outcome.state === 'code' || outcome.state === 'approved') && !shown) {
                shown = true
                io.say('')
                io.say(`    ${outcome.sas}`)
                io.say('')
                io.say('Approve in EtherPK only if it shows this same code, then press y here. Press n if the codes differ.')
            }
            if (outcome.state === 'approved') approved = outcome.deviceKey
        }
        if (approved && io.codesMatch()) return approved
        if (approved && !toldApproved) {
            toldApproved = true
            io.say('EtherPK approved this device. Press y if it showed the same code.')
        }
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
