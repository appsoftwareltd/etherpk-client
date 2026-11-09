import { describe, expect, it } from 'vitest'
import { missingCodeMessage, twoFactorFailureMessage, twoFactorStepPath } from './two-factor-step'

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

    // A sign-in held for its code started with a password, a social account or a verification
    // link, so the message names none of them.
    it('sends the user back to sign in once the pending sign-in has expired', () => {
        expect(twoFactorFailureMessage('backup', { status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' }))
            .toBe('This sign-in waited too long and has expired. Go back and sign in again.')
    })

    it('asks for a pause when the verify endpoint is rate limited', () => {
        expect(twoFactorFailureMessage('totp', { status: 429, message: 'Too many requests. Please try again later.' }))
            .toBe('Too many attempts. Wait a few seconds, then try again.')
    })

    it('ends this sign-in after too many wrong codes, and sends the user back to sign in', () => {
        expect(twoFactorFailureMessage('totp', { status: 400, code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' }))
            .toBe('Too many wrong codes for this sign-in. Go back and sign in again.')
    })

    it('says how long the account is locked after too many wrong codes across sign-ins', () => {
        expect(twoFactorFailureMessage('backup', { status: 429, code: 'ACCOUNT_TEMPORARILY_LOCKED' }))
            .toBe('Too many wrong codes, so this account cannot finish signing in for 15 minutes. Try again after that.')
    })
})

describe('the address of the two-factor step', () => {
    it('opens the sign-in page at the code step, carrying on where the sign-in was going', () => {
        expect(twoFactorStepPath('/login', '/account/tokens?created=1')).toBe('/login?two_factor=1&redirect=%2Faccount%2Ftokens%3Fcreated%3D1')
    })

    it('opens the code step alone when the sign-in was going nowhere in particular', () => {
        expect(twoFactorStepPath('/login', null)).toBe('/login?two_factor=1')
    })
})
