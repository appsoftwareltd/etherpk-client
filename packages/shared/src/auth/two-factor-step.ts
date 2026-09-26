/**
 * Copy for the two-factor step both sign-in pages share (TwoFactorStep.svelte): Corporate's and
 * the standalone Sync Server portal's. Better Auth's own messages ("Invalid code") say what
 * happened but not what to do next.
 */

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
    if (failure.status === 429) return 'Too many attempts. Wait a few seconds, then try again.'
    // The password step leaves a short-lived cookie naming the pending sign-in (ten minutes by
    // default). Once it has gone, no code can finish that sign-in.
    if (failure.code === 'INVALID_TWO_FACTOR_COOKIE') {
        return 'This sign-in waited too long and has expired. Go back to sign in and enter your password again.'
    }
    return mode === 'totp'
        ? 'That code did not work. Enter the code your authenticator app shows now.'
        : 'That backup code did not work. Each code works once, so check it or try another.'
}
