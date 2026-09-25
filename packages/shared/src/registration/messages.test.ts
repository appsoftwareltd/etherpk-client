import { describe, expect, it } from 'vitest'
import { REGISTRATION_REFUSAL_CODES, registrationRefusalMessage } from './messages'

describe('registration refusal messages', () => {
    it('names a distinct code for each reason', () => {
        expect(new Set(Object.values(REGISTRATION_REFUSAL_CODES)).size).toBe(3)
    })

    it('says what happened and what to do next for every reason', () => {
        expect(registrationRefusalMessage('closed')).toMatch(/not accepting new accounts/)
        expect(registrationRefusalMessage('ip')).toMatch(/IP address/)
        expect(registrationRefusalMessage('email')).toMatch(/address is not permitted/)
    })
})
