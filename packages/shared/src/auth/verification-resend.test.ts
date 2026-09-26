import { describe, expect, it } from 'vitest'
import {
    VERIFICATION_RESEND_COOLDOWN_SECONDS,
    isVerificationResendRequest,
    verificationResendWaitSeconds,
} from './verification-resend'

describe('isVerificationResendRequest', () => {
    it('recognises Better Auth’s resend endpoint, signed in or not', () => {
        expect(isVerificationResendRequest(new Request('https://www.test/api/auth/send-verification-email', { method: 'POST' })))
            .toBe(true)
    })

    it('leaves the email that sign-up and an email change send alone', () => {
        // The first email for an address must always go, however recently another was sent.
        expect(isVerificationResendRequest(new Request('https://www.test/api/auth/sign-up/email', { method: 'POST' })))
            .toBe(false)
        expect(isVerificationResendRequest(new Request('https://www.test/api/auth/change-email', { method: 'POST' })))
            .toBe(false)
        expect(isVerificationResendRequest(new Request('https://www.test/api/auth/verify-email?token=x')))
            .toBe(false)
        expect(isVerificationResendRequest(undefined)).toBe(false)
    })
})

describe('verificationResendWaitSeconds', () => {
    const now = Date.parse('2026-09-24T12:00:00Z')

    it('counts down the rest of the cooldown after a send', () => {
        expect(VERIFICATION_RESEND_COOLDOWN_SECONDS).toBe(60)
        expect(verificationResendWaitSeconds(new Date(now - 15_000), now)).toBe(45)
        expect(verificationResendWaitSeconds(new Date(now - 59_500), now)).toBe(1)
    })

    it('says zero once the cooldown has passed, or when nothing was sent', () => {
        expect(verificationResendWaitSeconds(new Date(now - 60_000), now)).toBe(0)
        expect(verificationResendWaitSeconds(null, now)).toBe(0)
    })

    it('does not invent a wait longer than the cooldown from a clock that runs ahead', () => {
        expect(verificationResendWaitSeconds(new Date(now + 30_000), now)).toBe(60)
    })
})
