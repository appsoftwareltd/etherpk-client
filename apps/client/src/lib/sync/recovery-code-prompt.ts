/**
 * The pending [[Recovery Code]] ritual, hoisted out of any one route (ADR 0035).
 *
 * Nothing durable exists until `commit()` runs, and `commit()` runs only from this dialog's
 * confirm (ADR 0029). On a fresh account that is the identity key and the new graph's keyring,
 * which exist only in memory until then; on a regenerate it is the re-wrap that retires the
 * current code, so until then the current code keeps working and walking away changes nothing.
 * Once an [[Import]] is a background [[Activity]], it can finish while the user is on any
 * route - so the prompt has to be answerable from any route too, exactly like the
 * device-approval prompt it sits beside in the app shell.
 *
 * A plain observable rather than a `$state` rune, matching `asset-picker.ts`: the callers
 * are module code outside any component.
 */

export interface PendingRecoveryCode {
    /** The code to display. */
    code: string
    /**
     * Which ritual this is. A `first` mint has no code before it; a `regenerate` is replacing a
     * code that still works, which is what earns it a way out. The dialog's copy follows this.
     */
    arrival: 'first' | 'regenerate'
    /** Why this appeared now, shown above the code. */
    reason?: string
    /** Makes the code real: writes the vault (first) or re-wraps it under this code (regenerate). */
    commit: () => Promise<void>
    /** Runs after a successful commit; receives the commit's error instead if it threw. */
    then?: (error?: Error) => void
    /** Regenerate only: dismiss without committing. The current code keeps working. */
    cancel?: () => void
}

export type RecoveryCodePrompt = PendingRecoveryCode | { code: null }

let state: RecoveryCodePrompt = { code: null }
const listeners = new Set<(s: RecoveryCodePrompt) => void>()

function emit(): void {
    for (const listener of listeners) listener(state)
}

/** Subscribe to the pending prompt; fires immediately with the current state. Returns an unsubscribe. */
export function subscribeRecoveryCodePrompt(listener: (s: RecoveryCodePrompt) => void): () => void {
    listeners.add(listener)
    listener(state)
    return () => listeners.delete(listener)
}

export function getRecoveryCodePrompt(): RecoveryCodePrompt {
    return state
}

/** Show the code. The ritual gates `commit`, so nothing durable exists until it is acknowledged. */
export function promptRecoveryCode(prompt: PendingRecoveryCode): void {
    state = prompt
    emit()
}

/**
 * The dialog's confirm: run the deferred commit, then hand control back. Clears the prompt
 * first so a slow `putVault` cannot leave the code on screen looking unanswered.
 */
export async function confirmRecoveryCode(): Promise<void> {
    if (state.code === null) return
    const { commit, then } = state
    state = { code: null }
    emit()
    try {
        await commit()
    } catch (err) {
        then?.(err as Error)
        return
    }
    then?.()
}

/** The dialog's cancel: drop the code without committing. Only a regenerate offers this. */
export function cancelRecoveryCode(): void {
    if (state.code === null) return
    const { cancel } = state
    state = { code: null }
    emit()
    cancel?.()
}
