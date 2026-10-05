/**
 * What the Device Passcode's fields say (ADR 0129): the advice under a new passcode as it is typed,
 * and the checks run before one is set. Any length from 4 is taken, so the advice says what a short
 * one stops and what it does not.
 */
import { DEVICE_PASSCODE_ADVISED_LENGTH, DEVICE_PASSCODE_MIN_LENGTH } from '../device-passcode'

/** The help under a new passcode, for what has been typed so far. */
export function passcodeAdvice(passcode: string): string {
    if (passcode.length < DEVICE_PASSCODE_MIN_LENGTH) {
        return `Use ${DEVICE_PASSCODE_MIN_LENGTH} or more characters. ${DEVICE_PASSCODE_ADVISED_LENGTH} or more is much harder to guess.`
    }
    if (passcode.length < DEVICE_PASSCODE_ADVISED_LENGTH) {
        return `${DEVICE_PASSCODE_MIN_LENGTH} to ${DEVICE_PASSCODE_ADVISED_LENGTH - 1} characters stops someone at the keyboard, not someone with a copy of this device's data. ${DEVICE_PASSCODE_ADVISED_LENGTH} or more is much harder to guess.`
    }
    return `${DEVICE_PASSCODE_ADVISED_LENGTH} or more characters is much harder to guess.`
}

/** What stops a new passcode being set, per field: too short, or entered differently the second time. */
export function newPasscodeErrors(passcode: string, again: string): { passcode: string | null; again: string | null } {
    if (passcode.length < DEVICE_PASSCODE_MIN_LENGTH) {
        return { passcode: `Use at least ${DEVICE_PASSCODE_MIN_LENGTH} characters.`, again: null }
    }
    if (!again) return { passcode: null, again: 'Enter the passcode again.' }
    if (again !== passcode) return { passcode: null, again: 'The two passcodes do not match.' }
    return { passcode: null, again: null }
}
