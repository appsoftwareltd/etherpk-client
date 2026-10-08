/**
 * The keys a device holds for an account are not available here: never unlocked on this device,
 * or locked with the Device Passcode (`device-passcode.ts`). Its own module so that both
 * `vault-session.ts` and `device-passcode.ts` can use it without importing each other.
 */
export class VaultLockedError extends Error {
    constructor(message = 'Vault is locked') {
        super(message)
        this.name = 'VaultLockedError'
    }
}

/**
 * The person closed an unlock prompt without unlocking. The keys are still locked, so it reads as
 * a {@link VaultLockedError} wherever a failure is described, and a flow the person started only to
 * get the keys can ignore it: they chose to stop.
 */
export class UnlockCancelledError extends VaultLockedError {
    constructor() {
        super('The unlock was cancelled, so the Encryption Keys on this device are still locked')
        this.name = 'UnlockCancelledError'
    }
}
