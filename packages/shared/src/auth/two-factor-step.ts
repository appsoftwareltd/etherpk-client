/**
 * Copy for the two-factor step both sign-in pages share (TwoFactorStep.svelte): Corporate's and
 * the standalone Sync Server portal's. Better Auth's own messages ("Invalid code") say what
 * happened but not what to do next.
 */

/**
 * How long Better Auth's two-factor account lockout lasts. Both apps pass it to the plugin's
 * `accountLockout.durationSeconds`, so the message below states the real wait.
 */
export const TWO_FACTOR_LOCKOUT_MINUTES = 15

/** Which second factor the step is asking for. */
export type TwoFactorMode = 'totp' | 'backup'

/** The part of a Better Auth client error the step reads. */
export interface TwoFactorFailure {
    status?: number
    code?: string
    message?: string
}

export function missingCodeMessage(mode: TwoFactorMode): string {
    return mode === 'totp'
        ? 'Enter the 6-digit code from your authenticator app.'
        : 'Enter one of your backup codes.'
}

export function twoFactorFailureMessage(mode: TwoFactorMode, failure: TwoFactorFailure): string {
    // Consecutive wrong codes across sign-ins lock the account's second factor (a 429 too, but
    // one that a few seconds' wait does not clear).
    if (failure.code === 'ACCOUNT_TEMPORARILY_LOCKED') {
        return `Too many wrong codes, so this account cannot finish signing in for ${TWO_FACTOR_LOCKOUT_MINUTES} minutes. Try again after that.`
    }
    if (failure.status === 429) return 'Too many attempts. Wait a few seconds, then try again.'
    // Five wrong codes end the pending sign-in: Better Auth clears its cookie, so the next code
    // would be refused as an expired sign-in.
    if (failure.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') {
        return 'Too many wrong codes for this sign-in. Go back to sign in and enter your password again.'
    }
    // The password step leaves a short-lived cookie naming the pending sign-in (ten minutes by
    // default). Once it has gone, no code can finish that sign-in.
    if (failure.code === 'INVALID_TWO_FACTOR_COOKIE') {
        return 'This sign-in waited too long and has expired. Go back to sign in and enter your password again.'
    }
    return mode === 'totp'
        ? 'That code did not work. Enter the code your authenticator app shows now.'
        : 'That backup code did not work. Each code works once, so check it or try another.'
}
