import { describe, expect, it } from 'vitest'
import {
    RecoveryCodeError, deriveVaultWrapKey, generateRecoveryCode, normalizeRecoveryCode, recoveryCodeToBytes,
} from './recovery-code'

describe('recovery code', () => {
    it('generates the documented shape', () => {
        expect(generateRecoveryCode()).toMatch(/^EPK1-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/)
    })
    it('normalizes case, separators, and Crockford confusables', () => {
        const code = generateRecoveryCode()
        const sloppy = code.toLowerCase().replaceAll('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l')
        expect(normalizeRecoveryCode(sloppy)).toBe(code)
    })
    it('rejects a missing prefix and a wrong length', () => {
        expect(() => normalizeRecoveryCode('ABCDE-FGHIJ')).toThrow(RecoveryCodeError)
        expect(() => normalizeRecoveryCode('EPK1-SHORT')).toThrow(RecoveryCodeError)
    })
    it('decodes to 16 bytes and derives a stable 32-byte wrap key', async () => {
        const code = generateRecoveryCode()
        expect(recoveryCodeToBytes(code)).toHaveLength(16)
        const key = await deriveVaultWrapKey(code)
        expect(key).toHaveLength(32)
        expect(Buffer.from(key).equals(Buffer.from(await deriveVaultWrapKey(code.toLowerCase())))).toBe(true)
        expect(Buffer.from(key).equals(Buffer.from(await deriveVaultWrapKey(generateRecoveryCode())))).toBe(false)
    })
})
