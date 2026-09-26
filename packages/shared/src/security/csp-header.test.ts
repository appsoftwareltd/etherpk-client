import { describe, expect, it } from 'vitest'
import { addCspSource } from './csp-header'

describe('addCspSource', () => {
    const policy = "default-src 'self'; script-src 'self' 'nonce-abc' sha256-xyz; connect-src 'self' blob:; img-src 'self'"

    it('appends the source to each named directive', () => {
        const result = addCspSource(policy, ['script-src', 'connect-src'], 'https://analytics.example.com')
        expect(result).toBe(
            "default-src 'self'; script-src 'self' 'nonce-abc' sha256-xyz https://analytics.example.com; "
            + "connect-src 'self' blob: https://analytics.example.com; img-src 'self'",
        )
    })

    it('leaves directives it was not asked about alone', () => {
        const result = addCspSource(policy, ['script-src'], 'https://analytics.example.com')
        expect(result).toContain("connect-src 'self' blob:;")
        expect(result).toContain("img-src 'self'")
    })

    it('does not add a directive the policy lacks, which would narrow what default-src allowed', () => {
        expect(addCspSource("default-src 'self'", ['connect-src'], 'https://a.example')).toBe("default-src 'self'")
    })

    it('does not list a source twice', () => {
        const once = addCspSource(policy, ['script-src'], 'https://a.example')
        expect(addCspSource(once, ['script-src'], 'https://a.example')).toBe(once)
    })
})
