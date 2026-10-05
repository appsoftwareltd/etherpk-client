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
