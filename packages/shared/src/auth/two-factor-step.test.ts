import { describe, expect, it } from 'vitest'
import { missingCodeMessage, twoFactorFailureMessage } from './two-factor-step'

describe('two-factor step copy', () => {
    it('asks for the code the current mode expects', () => {
        expect(missingCodeMessage('totp')).toBe('Enter the 6-digit code from your authenticator app.')
        expect(missingCodeMessage('backup')).toBe('Enter one of your backup codes.')
    })

    it('says a backup code works once when one is refused', () => {
        expect(twoFactorFailureMessage('backup', { status: 401, code: 'INVALID_BACKUP_CODE', message: 'Invalid backup code' }))
            .toBe('That backup code did not work. Each code works once, so check it or try another.')
        expect(twoFactorFailureMessage('totp', { status: 401, code: 'INVALID_CODE', message: 'Invalid code' }))
            .toBe('That code did not work. Enter the code your authenticator app shows now.')
    })

    it('sends the user back to the password step once the pending sign-in has expired', () => {
        expect(twoFactorFailureMessage('backup', { status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' }))
            .toBe('This sign-in waited too long and has expired. Go back to sign in and enter your password again.')
    })

    it('asks for a pause when the verify endpoint is rate limited', () => {
        expect(twoFactorFailureMessage('totp', { status: 429, message: 'Too many requests. Please try again later.' }))
            .toBe('Too many attempts. Wait a few seconds, then try again.')
    })
})
