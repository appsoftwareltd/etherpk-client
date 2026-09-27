/**
 * The cooldown on resending a verification email.
 *
 * Better Auth's `/send-verification-email` is limited per client address (3 a minute) and
 * answers without a session for any unverified address. The server adds a limit per account: at
 * most one resend a minute. The Account page counts the same minute down, so its button is never
 * live while a request would be skipped.
 *
 * Browser-safe: the Account page imports it as well as the servers.
 */

/** How long after one verification email the next resend is held back. */
export const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60

/** Why Better Auth is sending a verification email: a new account, a new address, or a resend. */
export type VerificationReason = 'new-account' | 'new-address' | 'resend'

/**
 * Why Better Auth is calling `sendVerificationEmail`, read from the request it passes as the
 * hook's second argument. `/send-verification-email` is a resend. An email change sends from
 * `/change-email` (an unverified account's, straight to the new address) or from `/verify-email`
 * (a verified account's, once the link sent to the current address is opened). Every other
 * caller is a sign-up: the email form, or a social sign-up whose provider did not verify the
 * address.
 */
export function verificationReason(request: Request | undefined): VerificationReason {
    const path = requestPath(request)
    if (path.endsWith('/send-verification-email')) return 'resend'
    if (path.endsWith('/change-email') || path.endsWith('/verify-email')) return 'new-address'
    return 'new-account'
}

/**
 * Whether someone asked for this verification email again. Only then does the cooldown apply:
 * sign-up and an email change send the first email for an address, which must always go.
 */
export function isVerificationResendRequest(request: Request | undefined): boolean {
    return verificationReason(request) === 'resend'
}

function requestPath(request: Request | undefined): string {
    if (!request) return ''
    try {
        return new URL(request.url).pathname
    } catch {
        return ''
    }
}

/**
 * Whole seconds until a resend is allowed after an email sent at `lastSentAt`, or 0 when it is
 * allowed now. Capped at the cooldown, so a device clock running ahead of the server's cannot
 * hold the button for longer than a minute.
 */
export function verificationResendWaitSeconds(lastSentAt: Date | null, now: number = Date.now()): number {
    if (!lastSentAt) return 0
    const remainingMs = lastSentAt.getTime() + VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000 - now
    if (remainingMs <= 0) return 0
    return Math.min(VERIFICATION_RESEND_COOLDOWN_SECONDS, Math.ceil(remainingMs / 1000))
}
