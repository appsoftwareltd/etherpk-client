import { describe, expect, it } from 'vitest'
import { newPasscodeErrors, passcodeAdvice } from './device-passcode-copy'

describe('what the Device Passcode field says as the user types (ADR 0129)', () => {
    it('asks for four characters until there are four', () => {
        expect(passcodeAdvice('')).toBe('Use 4 or more characters. 8 or more is much harder to guess.')
        expect(passcodeAdvice('abc')).toBe('Use 4 or more characters. 8 or more is much harder to guess.')
    })

    it('says what a short passcode does and does not stop', () => {
        expect(passcodeAdvice('1234')).toBe(
            "4 to 7 characters stops someone at the keyboard, not someone with a copy of this device's data. 8 or more is much harder to guess.",
        )
        expect(passcodeAdvice('1234567')).toContain('4 to 7 characters')
    })

    it('says a passcode of eight or more is much harder to guess', () => {
        expect(passcodeAdvice('12345678')).toBe('8 or more characters is much harder to guess.')
    })
})

describe('checking a new Device Passcode before it is set', () => {
    it('refuses one shorter than four characters at its own field', () => {
        expect(newPasscodeErrors('abc', 'abc')).toEqual({ passcode: 'Use at least 4 characters.', again: null })
    })

    it('refuses a second entry that differs, at the second field', () => {
        expect(newPasscodeErrors('abcd', 'abce')).toEqual({ passcode: null, again: 'The two passcodes do not match.' })
        expect(newPasscodeErrors('abcd', '')).toEqual({ passcode: null, again: 'Enter the passcode again.' })
    })

    it('takes a passcode of four or more entered the same twice', () => {
        expect(newPasscodeErrors('abcd', 'abcd')).toEqual({ passcode: null, again: null })
    })
})
