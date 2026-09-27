import { describe, expect, it } from 'vitest'
import { confirmAddressChangeEmail, passwordResetEmail, verifyAddressEmail } from './account-emails'

const URL_WITH_QUERY = 'https://accounts.example.com/api/auth/verify-email?token=abc&callbackURL=%2Faccount'

describe('account emails', () => {
    // Each says what it is for, how long the link lasts and what to do if it was not asked for,
    // in both parts: a one-line "Click here" message reads as phishing.
    it.each([
        ['a new account', verifyAddressEmail({ url: URL_WITH_QUERY, email: 'sam@example.com', reason: 'new-account' })],
        ['a resend', verifyAddressEmail({ url: URL_WITH_QUERY, email: 'sam@example.com', reason: 'resend' })],
        ['a new address', verifyAddressEmail({ url: URL_WITH_QUERY, email: 'sam@example.com', reason: 'new-address' })],
        ['an address change', confirmAddressChangeEmail({ url: URL_WITH_QUERY, newEmail: 'sam@example.com' })],
        ['a password reset', passwordResetEmail({ url: URL_WITH_QUERY })],
    ])('%s has a purpose, the link, its lifetime and an "if this was not you" line in both parts', (_, email) => {
        for (const part of [email.html, email.text]) {
            expect(part).toContain('one hour')
            expect(part).toMatch(/If you did not/)
        }
        expect(email.text).toContain(URL_WITH_QUERY)
        expect(email.html).toContain(`href="${URL_WITH_QUERY.replaceAll('&', '&amp;')}"`)
        expect(email.subject).toContain('EtherPK')
    })

    it('tells a new account apart from a change of address', () => {
        expect(verifyAddressEmail({ url: URL_WITH_QUERY, email: 'sam@example.com', reason: 'new-account' }).subject)
            .toBe('Verify your EtherPK email address')
        expect(verifyAddressEmail({ url: URL_WITH_QUERY, email: 'sam@example.com', reason: 'new-address' }).subject)
            .toBe('Confirm your new EtherPK email address')
    })

    it('escapes an address that carries markup', () => {
        const email = confirmAddressChangeEmail({ url: URL_WITH_QUERY, newEmail: '<img src=x onerror=alert(1)>@example.com' })
        expect(email.html).not.toContain('<img src=x')
        expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;@example.com')
    })
})
