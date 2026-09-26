import { describe, expect, it } from 'vitest'
import { PASSWORD_HELP, PASSWORD_MIN_LENGTH, passwordWeakness } from './password-strength'

describe('passwordWeakness', () => {
    it('accepts a long password nobody else uses', async () => {
        expect(await passwordWeakness('violet ferry candle 42')).toBeNull()
    })

    it('refuses one shorter than the minimum', async () => {
        expect(await passwordWeakness('a1b2c3d')).toBe(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    })

    it.each(['password', '12345678', 'Password1', 'iloveyou', 'QWERTYUIOP'])('refuses the common password %s, whatever its case', async (password) => {
        expect(await passwordWeakness(password)).toBe('This is one of the most used passwords. Choose one that is harder to guess.')
    })

    it('refuses one character repeated', async () => {
        expect(await passwordWeakness('zzzzzzzzzzzz')).toBe('One character repeated is too easy to guess.')
    })

    it('refuses a password that contains the name part of the account email', async () => {
        expect(await passwordWeakness('Morwenna!2026', { email: 'morwenna@example.com' }))
            .toBe('Leave your email address out of your password.')
    })

    it('ignores a name part too short to be telling', async () => {
        expect(await passwordWeakness('violet ferry candle 42', { email: 'vio@example.com' })).toBeNull()
    })

    it('refuses the service name', async () => {
        expect(await passwordWeakness('MyEtherPK-2026')).toBe('Leave the name EtherPK out of your password.')
    })

    it('states the rule for help text', () => {
        expect(PASSWORD_HELP).toBe('At least 8 characters, and not a commonly used password.')
    })
})
