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

/**
 * Whether Better Auth is calling `sendVerificationEmail` because someone asked for a resend.
 * Only then does the cooldown apply: sign-up and an email change send the first email for an
 * address, which must always go. Better Auth passes the triggering request as the hook's second
 * argument.
 */
export function isVerificationResendRequest(request: Request | undefined): boolean {
    if (!request) return false
    try {
        return new URL(request.url).pathname.endsWith('/send-verification-email')
    } catch {
        return false
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
