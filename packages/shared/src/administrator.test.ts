import { describe, expect, it } from 'vitest'

import { isConfiguredAdministrator } from './administrator'

describe('the configured administrator', () => {
    it('matches the named address regardless of case or padding', () => {
        expect(isConfiguredAdministrator('Ops@Example.com', ' ops@example.com ')).toBe(true)
        expect(isConfiguredAdministrator(' ops@example.com', 'OPS@EXAMPLE.COM')).toBe(true)
    })

    it('grants nobody when the deployment names nobody', () => {
        expect(isConfiguredAdministrator('ops@example.com', undefined)).toBe(false)
        expect(isConfiguredAdministrator('ops@example.com', '')).toBe(false)
        expect(isConfiguredAdministrator('ops@example.com', '   ')).toBe(false)
    })

    it('grants nobody to an identity with no address of its own', () => {
        expect(isConfiguredAdministrator(null, 'ops@example.com')).toBe(false)
        expect(isConfiguredAdministrator(undefined, 'ops@example.com')).toBe(false)
        expect(isConfiguredAdministrator('', 'ops@example.com')).toBe(false)
    })

    it('does not match a different address', () => {
        expect(isConfiguredAdministrator('someone@example.com', 'ops@example.com')).toBe(false)
        expect(isConfiguredAdministrator('ops@example.com.evil.test', 'ops@example.com')).toBe(false)
    })
})
