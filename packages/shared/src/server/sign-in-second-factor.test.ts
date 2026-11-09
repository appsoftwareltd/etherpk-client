import { describe, expect, it } from 'vitest'
import { isExemptFromSecondFactor, pathOnThisOrigin } from './sign-in-second-factor'

describe('which new sessions wait for the second factor', () => {
    // A passkey proves the device and the person in one step, the two-factor routes are the code
    // step itself, the password routes are held by Better Auth's own two-factor plugin, and an
    // administrator's impersonation acts on a session that is already signed in.
    it.each([
        '/passkey/verify-authentication',
        '/two-factor/verify-totp',
        '/two-factor/verify-backup-code',
        '/two-factor/enable',
        '/sign-in/email',
        '/sign-in/username',
        '/sign-in/phone-number',
        '/admin/impersonate-user',
        '/admin/stop-impersonating',
    ])('lets %s through', (path) => {
        expect(isExemptFromSecondFactor(path)).toBe(true)
    })

    // Every other way of signing in waits, including one added after this list was written.
    it.each(['/callback/:id', '/sign-in/social', '/verify-email', '/magic-link/verify'])('holds %s for the code', (path) => {
        expect(isExemptFromSecondFactor(path)).toBe(false)
    })
})

describe('where a held sign-in was going', () => {
    const base = 'http://localhost:5174/api/auth'

    it('keeps a path on this server', () => {
        expect(pathOnThisOrigin('/dashboard', base)).toBe('/dashboard')
        expect(pathOnThisOrigin('http://localhost:5174/account?tab=security#mfa', base)).toBe('/account?tab=security#mfa')
    })

    it('drops an address on another origin', () => {
        expect(pathOnThisOrigin('https://garden.example/account', base)).toBeNull()
        expect(pathOnThisOrigin('//garden.example/account', base)).toBeNull()
    })
})
